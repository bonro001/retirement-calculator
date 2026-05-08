use rayon::prelude::*;
use std::borrow::Cow;
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

const MAX_WORKGROUPS_X: u32 = 65_535;

const GPU_POC_SHADER: &str = r#"
struct Params {
  item_count: u32,
  inner_iters: u32,
  policy_count: u32,
  trial_count: u32,
  years: u32,
  stage: u32,
  dispatch_width: u32,
  _pad0: u32,
  initial_wealth: f32,
  annual_spend: f32,
  flat_tax_rate: f32,
  success_floor: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> tape: array<f32>;
@group(0) @binding(2) var<storage, read> policies: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;

fn progressive_tax(gross: f32) -> f32 {
  var taxable = max(gross - 29200.0, 0.0);
  var tax = 0.0;
  var previous = 0.0;

  let top0 = 23200.0;
  if (taxable > previous) {
    let segment = min(taxable, top0) - previous;
    tax = tax + max(segment, 0.0) * 0.10;
    previous = top0;
  }

  let top1 = 94300.0;
  if (taxable > previous) {
    let segment = min(taxable, top1) - previous;
    tax = tax + max(segment, 0.0) * 0.12;
    previous = top1;
  }

  let top2 = 201050.0;
  if (taxable > previous) {
    let segment = min(taxable, top2) - previous;
    tax = tax + max(segment, 0.0) * 0.22;
    previous = top2;
  }

  let top3 = 383900.0;
  if (taxable > previous) {
    let segment = min(taxable, top3) - previous;
    tax = tax + max(segment, 0.0) * 0.24;
    previous = top3;
  }

  let top4 = 487450.0;
  if (taxable > previous) {
    let segment = min(taxable, top4) - previous;
    tax = tax + max(segment, 0.0) * 0.32;
    previous = top4;
  }

  let top5 = 731200.0;
  if (taxable > previous) {
    let segment = min(taxable, top5) - previous;
    tax = tax + max(segment, 0.0) * 0.35;
    previous = top5;
  }

  if (taxable > previous) {
    tax = tax + (taxable - previous) * 0.37;
  }

  return tax;
}

@compute @workgroup_size(__WORKGROUP_SIZE__)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let item = gid.x + gid.y * params.dispatch_width;
  if (item >= params.item_count) {
    return;
  }

  if (params.stage == 0u) {
    var x = tape[item];
    var i = 0u;
    loop {
      if (i >= params.inner_iters) {
        break;
      }
      let lane = f32((i + item) & 7u);
      x = x * 1.0000001 + lane * 0.000001;
      let y = x * x * 0.0000001 + 0.999999;
      if (((i + item) & 15u) == 0u) {
        x = x - y * 0.00001;
      } else {
        x = x + y * 0.000001;
      }
      i = i + 1u;
    }
    output[item] = x;
    return;
  }

  let policy_index = item / params.trial_count;
  let trial_index = item - policy_index * params.trial_count;
  let withdrawal = policies[policy_index];
  var wealth = params.initial_wealth;

  var year = 0u;
  loop {
    if (year >= params.years) {
      break;
    }
    let return_factor = tape[trial_index * params.years + year];
    wealth = wealth * return_factor;

    var tax = withdrawal * params.flat_tax_rate;
    if (params.stage == 2u) {
      tax = progressive_tax(withdrawal);
    }

    wealth = wealth - withdrawal - tax;
    if (wealth <= 0.0) {
      wealth = 0.0;
      break;
    }
    year = year + 1u;
  }

  output[item] = wealth;
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Params {
    item_count: u32,
    inner_iters: u32,
    policy_count: u32,
    trial_count: u32,
    years: u32,
    stage: u32,
    dispatch_width: u32,
    _pad0: u32,
    initial_wealth: f32,
    annual_spend: f32,
    flat_tax_rate: f32,
    success_floor: f32,
}

unsafe impl bytemuck::Zeroable for Params {}
unsafe impl bytemuck::Pod for Params {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Arithmetic,
    Simplified,
    BracketedTax,
}

impl Stage {
    fn shader_stage(self) -> u32 {
        match self {
            Self::Arithmetic => 0,
            Self::Simplified => 1,
            Self::BracketedTax => 2,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Arithmetic => "stage0-arithmetic",
            Self::Simplified => "stage1-simplified",
            Self::BracketedTax => "stage2-bracketed-tax",
        }
    }
}

struct Cli {
    stage: Stage,
    items: usize,
    inner_iters: u32,
    policies: usize,
    trials: usize,
    years: usize,
    workgroup_size: u32,
}

struct GpuContext {
    device: wgpu::Device,
    queue: wgpu::Queue,
    info: wgpu::AdapterInfo,
    limits: wgpu::Limits,
    features: wgpu::Features,
}

struct GpuRun {
    output: Vec<f32>,
    elapsed: Duration,
    upload_elapsed: Duration,
    dispatch_elapsed: Duration,
    readback_elapsed: Duration,
    groups_x: u32,
    groups_y: u32,
}

#[derive(Debug, Clone, Copy)]
struct Summary {
    success_rate: f32,
    p10: f32,
    p25: f32,
    p50: f32,
    p75: f32,
    p90: f32,
}

fn main() {
    if let Err(error) = pollster::block_on(run()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let cli = parse_cli(std::env::args().collect())?;
    let gpu = init_gpu().await?;
    println!(
        "gpu_poc adapter name=\"{}\" vendor={} device={} backend={:?}",
        gpu.info.name, gpu.info.vendor, gpu.info.device, gpu.info.backend
    );
    println!(
        "gpu_poc limits max_buffer={} max_storage_binding={} max_workgroups=({}, {}, {}) shader_f64_supported={}",
        gpu.limits.max_buffer_size,
        gpu.limits.max_storage_buffer_binding_size,
        gpu.limits.max_compute_workgroups_per_dimension,
        gpu.limits.max_compute_workgroups_per_dimension,
        gpu.limits.max_compute_workgroups_per_dimension,
        gpu.features.contains(wgpu::Features::SHADER_F64)
    );

    match cli.stage {
        Stage::Arithmetic => run_stage0(&gpu, &cli).await,
        Stage::Simplified | Stage::BracketedTax => run_sim_stage(&gpu, &cli).await,
    }
}

async fn init_gpu() -> Result<GpuContext, String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        dx12_shader_compiler: Default::default(),
        flags: wgpu::InstanceFlags::default(),
        gles_minor_version: wgpu::Gles3MinorVersion::Automatic,
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .ok_or("wgpu could not find a GPU adapter")?;
    let info = adapter.get_info();
    let limits = adapter.limits();
    let features = adapter.features();
    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("gpu-poc-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits {
                    max_buffer_size: limits.max_buffer_size,
                    max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size,
                    ..wgpu::Limits::downlevel_defaults()
                },
            },
            None,
        )
        .await
        .map_err(|error| format!("wgpu request_device failed: {error}"))?;
    Ok(GpuContext {
        device,
        queue,
        info,
        limits,
        features,
    })
}

async fn run_stage0(gpu: &GpuContext, cli: &Cli) -> Result<(), String> {
    let item_count = cli.items;
    let input = (0..item_count)
        .map(|index| 0.25 + (index as f32 % 1024.0) * 0.0001)
        .collect::<Vec<_>>();
    let params = build_params(cli.stage, item_count, cli.inner_iters, 1, item_count, 1)?;

    let cpu_start = Instant::now();
    let cpu_output = stage0_cpu(&input, cli.inner_iters);
    let cpu_elapsed = cpu_start.elapsed();

    let gpu_run = run_gpu(gpu, params, &input, &[0.0], item_count, cli.workgroup_size).await?;
    let comparison = compare_outputs(&cpu_output, &gpu_run.output);

    print_stage_header(cli.stage);
    println!(
        "work items={} inner_iters={} total_loop_iters={}",
        item_count,
        cli.inner_iters,
        item_count as u128 * cli.inner_iters as u128
    );
    println!(
        "cpu_ms={:.3} gpu_ms={:.3} upload_ms={:.3} dispatch_ms={:.3} readback_ms={:.3} speedup={:.2}x workgroup_size={} dispatch=({}, {})",
        ms(cpu_elapsed),
        ms(gpu_run.elapsed),
        ms(gpu_run.upload_elapsed),
        ms(gpu_run.dispatch_elapsed),
        ms(gpu_run.readback_elapsed),
        speedup(cpu_elapsed, gpu_run.elapsed),
        cli.workgroup_size,
        gpu_run.groups_x,
        gpu_run.groups_y
    );
    println!(
        "parity max_abs={:.8} max_rel={:.8} mismatches_gt_1e-6={}",
        comparison.max_abs, comparison.max_rel, comparison.mismatches
    );
    Ok(())
}

async fn run_sim_stage(gpu: &GpuContext, cli: &Cli) -> Result<(), String> {
    let policies = cli.policies;
    let trials = cli.trials;
    let years = cli.years;
    let item_count = policies
        .checked_mul(trials)
        .ok_or("policy x trial count overflowed usize")?;
    let tape = generate_return_factors(trials, years, 20_260_508);
    let policy_spending = generate_policy_spending(policies);
    let params = build_params(cli.stage, item_count, 0, policies, trials, years)?;

    let cpu_start = Instant::now();
    let cpu_output = sim_cpu(cli.stage, &tape, &policy_spending, trials, years, params);
    let cpu_elapsed = cpu_start.elapsed();

    let gpu_run = run_gpu(
        gpu,
        params,
        &tape,
        &policy_spending,
        item_count,
        cli.workgroup_size,
    )
    .await?;
    let comparison = compare_outputs(&cpu_output, &gpu_run.output);

    let summary_start = Instant::now();
    let cpu_summaries = summarize_policies(&cpu_output, policies, trials, params.success_floor);
    let gpu_summaries = summarize_policies(&gpu_run.output, policies, trials, params.success_floor);
    let summary_elapsed = summary_start.elapsed();
    let summary_comparison = compare_summaries(&cpu_summaries, &gpu_summaries);

    print_stage_header(cli.stage);
    println!(
        "policies={} trials={} years={} outputs={} tape_values={}",
        policies,
        trials,
        years,
        item_count,
        tape.len()
    );
    println!(
        "cpu_ms={:.3} gpu_ms={:.3} upload_ms={:.3} dispatch_ms={:.3} readback_ms={:.3} speedup={:.2}x workgroup_size={} dispatch=({}, {}) summary_ms={:.3}",
        ms(cpu_elapsed),
        ms(gpu_run.elapsed),
        ms(gpu_run.upload_elapsed),
        ms(gpu_run.dispatch_elapsed),
        ms(gpu_run.readback_elapsed),
        speedup(cpu_elapsed, gpu_run.elapsed),
        cli.workgroup_size,
        gpu_run.groups_x,
        gpu_run.groups_y,
        ms(summary_elapsed)
    );
    println!(
        "ending_wealth_parity max_abs={:.8} max_rel={:.8} mismatches_gt_1e-6={}",
        comparison.max_abs, comparison.max_rel, comparison.mismatches
    );
    println!(
        "summary_parity max_abs={:.8} max_rel={:.8} mismatches_gt_1e-4={}",
        summary_comparison.max_abs, summary_comparison.max_rel, summary_comparison.mismatches
    );
    if let Some(first) = gpu_summaries.first() {
        println!(
            "first_policy_summary success={:.4} p10={:.2} p50={:.2} p90={:.2}",
            first.success_rate, first.p10, first.p50, first.p90
        );
    }
    Ok(())
}

async fn run_gpu(
    gpu: &GpuContext,
    params: Params,
    tape: &[f32],
    policies: &[f32],
    output_len: usize,
    workgroup_size: u32,
) -> Result<GpuRun, String> {
    let output_size = (output_len * std::mem::size_of::<f32>()) as wgpu::BufferAddress;
    if output_size == 0 {
        return Err("GPU output buffer would be empty".to_string());
    }
    let (groups_x, groups_y, dispatch_width) = dispatch_shape(output_len, workgroup_size)?;
    let params = Params {
        dispatch_width,
        ..params
    };

    let shader_source = shader_source(workgroup_size);
    let shader = gpu
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gpu-poc-wgsl"),
            source: wgpu::ShaderSource::Wgsl(Cow::Owned(shader_source)),
        });
    let bind_group_layout = gpu
        .device
        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gpu-poc-bind-layout"),
            entries: &[
                bind_entry(0, wgpu::BufferBindingType::Uniform, false),
                bind_entry(
                    1,
                    wgpu::BufferBindingType::Storage { read_only: true },
                    false,
                ),
                bind_entry(
                    2,
                    wgpu::BufferBindingType::Storage { read_only: true },
                    false,
                ),
                bind_entry(
                    3,
                    wgpu::BufferBindingType::Storage { read_only: false },
                    false,
                ),
            ],
        });
    let pipeline_layout = gpu
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gpu-poc-pipeline-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
    let pipeline = gpu
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("gpu-poc-pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: "main",
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        });

    let total_start = Instant::now();
    let upload_start = Instant::now();
    let params_buffer = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu-poc-params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
    let tape_buffer = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu-poc-tape"),
            contents: bytemuck::cast_slice(tape),
            usage: wgpu::BufferUsages::STORAGE,
        });
    let policy_buffer = gpu
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu-poc-policies"),
            contents: bytemuck::cast_slice(policies),
            usage: wgpu::BufferUsages::STORAGE,
        });
    let output_buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("gpu-poc-output"),
        size: output_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback_buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("gpu-poc-readback"),
        size: output_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("gpu-poc-bind-group"),
        layout: &bind_group_layout,
        entries: &[
            buffer_entry(0, &params_buffer),
            buffer_entry(1, &tape_buffer),
            buffer_entry(2, &policy_buffer),
            buffer_entry(3, &output_buffer),
        ],
    });
    let upload_elapsed = upload_start.elapsed();

    let dispatch_start = Instant::now();
    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gpu-poc-encoder"),
        });
    {
        let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("gpu-poc-compute-pass"),
            timestamp_writes: None,
        });
        compute_pass.set_pipeline(&pipeline);
        compute_pass.set_bind_group(0, &bind_group, &[]);
        compute_pass.dispatch_workgroups(groups_x, groups_y, 1);
    }
    encoder.copy_buffer_to_buffer(&output_buffer, 0, &readback_buffer, 0, output_size);
    gpu.queue.submit(Some(encoder.finish()));
    gpu.device.poll(wgpu::Maintain::Wait);
    let dispatch_elapsed = dispatch_start.elapsed();

    let readback_start = Instant::now();
    let slice = readback_buffer.slice(..);
    let (sender, receiver) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    gpu.device.poll(wgpu::Maintain::Wait);
    receiver
        .recv()
        .map_err(|error| format!("GPU map callback failed: {error}"))?
        .map_err(|error| format!("GPU readback map failed: {error}"))?;
    let mapped = slice.get_mapped_range();
    let output = bytemuck::cast_slice::<u8, f32>(&mapped).to_vec();
    drop(mapped);
    readback_buffer.unmap();
    let readback_elapsed = readback_start.elapsed();

    Ok(GpuRun {
        output,
        elapsed: total_start.elapsed(),
        upload_elapsed,
        dispatch_elapsed,
        readback_elapsed,
        groups_x,
        groups_y,
    })
}

fn bind_entry(
    binding: u32,
    ty: wgpu::BufferBindingType,
    has_dynamic_offset: bool,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty,
            has_dynamic_offset,
            min_binding_size: None,
        },
        count: None,
    }
}

fn buffer_entry<'a>(binding: u32, buffer: &'a wgpu::Buffer) -> wgpu::BindGroupEntry<'a> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

fn build_params(
    stage: Stage,
    item_count: usize,
    inner_iters: u32,
    policies: usize,
    trials: usize,
    years: usize,
) -> Result<Params, String> {
    Ok(Params {
        item_count: checked_u32(item_count, "item_count")?,
        inner_iters,
        policy_count: checked_u32(policies, "policy_count")?,
        trial_count: checked_u32(trials, "trial_count")?,
        years: checked_u32(years, "years")?,
        stage: stage.shader_stage(),
        dispatch_width: 0,
        _pad0: 0,
        initial_wealth: 1_000_000.0,
        annual_spend: 55_000.0,
        flat_tax_rate: 0.12,
        success_floor: 1.0,
    })
}

fn dispatch_shape(item_count: usize, workgroup_size: u32) -> Result<(u32, u32, u32), String> {
    let workgroups = (checked_u32(item_count, "item_count")? + workgroup_size - 1) / workgroup_size;
    let groups_x = workgroups.min(MAX_WORKGROUPS_X).max(1);
    let groups_y = (workgroups + groups_x - 1) / groups_x;
    if groups_y > MAX_WORKGROUPS_X {
        return Err(format!(
            "dispatch too large: {item_count} items need {groups_y} y workgroups"
        ));
    }
    Ok((groups_x, groups_y, groups_x * workgroup_size))
}

fn checked_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}={value} exceeds u32"))
}

fn shader_source(workgroup_size: u32) -> String {
    GPU_POC_SHADER.replace("__WORKGROUP_SIZE__", &workgroup_size.to_string())
}

fn stage0_cpu(input: &[f32], inner_iters: u32) -> Vec<f32> {
    input
        .par_iter()
        .enumerate()
        .map(|(item, value)| {
            let item = item as u32;
            let mut x = *value;
            let mut i = 0;
            while i < inner_iters {
                let lane = ((i + item) & 7) as f32;
                x = x * 1.0000001 + lane * 0.000001;
                let y = x * x * 0.0000001 + 0.999999;
                if ((i + item) & 15) == 0 {
                    x -= y * 0.00001;
                } else {
                    x += y * 0.000001;
                }
                i += 1;
            }
            x
        })
        .collect()
}

fn sim_cpu(
    stage: Stage,
    tape: &[f32],
    policy_spending: &[f32],
    trials: usize,
    years: usize,
    params: Params,
) -> Vec<f32> {
    let item_count = policy_spending.len() * trials;
    (0..item_count)
        .into_par_iter()
        .map(|item| {
            let policy = item / trials;
            let trial = item - policy * trials;
            let withdrawal = policy_spending[policy];
            let mut wealth = params.initial_wealth;
            for year in 0..years {
                wealth *= tape[trial * years + year];
                let tax = match stage {
                    Stage::BracketedTax => progressive_tax_cpu(withdrawal),
                    _ => withdrawal * params.flat_tax_rate,
                };
                wealth -= withdrawal + tax;
                if wealth <= 0.0 {
                    wealth = 0.0;
                    break;
                }
            }
            wealth
        })
        .collect()
}

fn progressive_tax_cpu(gross: f32) -> f32 {
    let taxable = (gross - 29_200.0).max(0.0);
    let brackets = [
        (23_200.0, 0.10),
        (94_300.0, 0.12),
        (201_050.0, 0.22),
        (383_900.0, 0.24),
        (487_450.0, 0.32),
        (731_200.0, 0.35),
        (f32::INFINITY, 0.37),
    ];
    let mut previous = 0.0;
    let mut tax = 0.0;
    for (top, rate) in brackets {
        if taxable <= previous {
            break;
        }
        let segment = taxable.min(top) - previous;
        if segment > 0.0 {
            tax += segment * rate;
        }
        previous = top;
    }
    tax
}

fn generate_policy_spending(policies: usize) -> Vec<f32> {
    if policies <= 1 {
        return vec![55_000.0];
    }
    (0..policies)
        .map(|index| {
            let fraction = index as f32 / (policies - 1) as f32;
            38_000.0 + fraction * 72_000.0
        })
        .collect()
}

fn generate_return_factors(trials: usize, years: usize, seed: u32) -> Vec<f32> {
    let mut out = Vec::with_capacity(trials * years);
    for trial in 0..trials {
        for year in 0..years {
            let normal = approx_standard_normal(seed, trial as u32, year as u32);
            let annual_return = (0.055 + normal * 0.145).clamp(-0.45, 0.42);
            out.push(1.0 + annual_return);
        }
    }
    out
}

fn approx_standard_normal(seed: u32, trial: u32, year: u32) -> f32 {
    let mut state =
        mix_u32(seed ^ trial.wrapping_mul(0x9e37_79b9) ^ year.wrapping_mul(0x85eb_ca6b));
    let mut sum = 0.0_f32;
    for _ in 0..12 {
        state = mix_u32(state.wrapping_add(0x6d2b_79f5));
        sum += (state as f32) / 4_294_967_296.0;
    }
    sum - 6.0
}

fn mix_u32(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x85eb_ca6b);
    value ^= value >> 13;
    value = value.wrapping_mul(0xc2b2_ae35);
    value ^= value >> 16;
    value
}

fn summarize_policies(
    output: &[f32],
    policies: usize,
    trials: usize,
    success_floor: f32,
) -> Vec<Summary> {
    (0..policies)
        .into_par_iter()
        .map(|policy| {
            let start = policy * trials;
            let end = start + trials;
            let mut values = output[start..end].to_vec();
            values.sort_by(|left, right| left.total_cmp(right));
            let success_count = values
                .iter()
                .filter(|value| **value >= success_floor)
                .count();
            Summary {
                success_rate: success_count as f32 / trials as f32,
                p10: percentile_sorted(&values, 0.10),
                p25: percentile_sorted(&values, 0.25),
                p50: percentile_sorted(&values, 0.50),
                p75: percentile_sorted(&values, 0.75),
                p90: percentile_sorted(&values, 0.90),
            }
        })
        .collect()
}

fn percentile_sorted(values: &[f32], fraction: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f32 * fraction).floor() as usize;
    values[index.min(values.len() - 1)]
}

struct Comparison {
    max_abs: f32,
    max_rel: f32,
    mismatches: usize,
}

fn compare_outputs(left: &[f32], right: &[f32]) -> Comparison {
    compare_values(left.iter().copied(), right.iter().copied(), 1.0e-6)
}

fn compare_summaries(left: &[Summary], right: &[Summary]) -> Comparison {
    compare_values(
        left.iter().flat_map(summary_values),
        right.iter().flat_map(summary_values),
        1.0e-4,
    )
}

fn summary_values(summary: &Summary) -> [f32; 6] {
    [
        summary.success_rate,
        summary.p10,
        summary.p25,
        summary.p50,
        summary.p75,
        summary.p90,
    ]
}

fn compare_values<I, J>(left: I, right: J, tolerance: f32) -> Comparison
where
    I: IntoIterator<Item = f32>,
    J: IntoIterator<Item = f32>,
{
    let mut max_abs = 0.0_f32;
    let mut max_rel = 0.0_f32;
    let mut mismatches = 0_usize;
    for (a, b) in left.into_iter().zip(right) {
        let abs = (a - b).abs();
        let rel = abs / a.abs().max(1.0);
        max_abs = max_abs.max(abs);
        max_rel = max_rel.max(rel);
        if rel > tolerance && abs > tolerance {
            mismatches += 1;
        }
    }
    Comparison {
        max_abs,
        max_rel,
        mismatches,
    }
}

fn parse_cli(args: Vec<String>) -> Result<Cli, String> {
    if args.len() < 2 || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Err(help());
    }
    let stage = match args[1].as_str() {
        "stage0" | "arithmetic" => Stage::Arithmetic,
        "stage1" | "simplified" => Stage::Simplified,
        "stage2" | "tax" => Stage::BracketedTax,
        other => return Err(format!("unknown stage '{other}'\n\n{}", help())),
    };
    let mut cli = Cli {
        stage,
        items: 100_000,
        inner_iters: 1_000,
        policies: 1_000,
        trials: 1_000,
        years: 30,
        workgroup_size: 256,
    };
    let mut index = 2;
    while index < args.len() {
        let arg = &args[index];
        let next = args
            .get(index + 1)
            .ok_or_else(|| format!("{arg} needs a value"))?;
        match arg.as_str() {
            "--items" => cli.items = parse_usize(next, arg)?,
            "--inner-iters" => cli.inner_iters = parse_u32(next, arg)?,
            "--policies" => cli.policies = parse_usize(next, arg)?,
            "--trials" => cli.trials = parse_usize(next, arg)?,
            "--years" => cli.years = parse_usize(next, arg)?,
            "--workgroup-size" => cli.workgroup_size = parse_workgroup_size(next)?,
            other => return Err(format!("unknown argument '{other}'\n\n{}", help())),
        }
        index += 2;
    }
    if cli.stage != Stage::Arithmetic {
        cli.items = cli.policies * cli.trials;
    }
    Ok(cli)
}

fn parse_usize(value: &str, label: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("{label} must be an integer"))
        .map(|value| value.max(1))
}

fn parse_u32(value: &str, label: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("{label} must be an integer"))
        .map(|value| value.max(1))
}

fn parse_workgroup_size(value: &str) -> Result<u32, String> {
    let parsed = parse_u32(value, "--workgroup-size")?;
    match parsed {
        64 | 128 | 256 => Ok(parsed),
        _ => Err("--workgroup-size must be one of 64, 128, or 256".to_string()),
    }
}

fn help() -> String {
    "usage:
  cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage0 --items 100000 --inner-iters 1000 --workgroup-size 256
  cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage1 --policies 1000 --trials 1000 --workgroup-size 256
  cargo run --release --manifest-path flight-engine-rs/Cargo.toml --bin gpu_poc -- stage2 --policies 1000 --trials 1000 --workgroup-size 256"
        .to_string()
}

fn print_stage_header(stage: Stage) {
    println!("gpu_poc result stage={}", stage.label());
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn speedup(cpu: Duration, gpu: Duration) -> f64 {
    if gpu.as_nanos() == 0 {
        return 0.0;
    }
    cpu.as_secs_f64() / gpu.as_secs_f64()
}
