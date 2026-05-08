use flight_engine::candidate_engine::handle_request;
use serde_json::Value;
use std::env;
use std::io::{self, BufRead, Read, Write};

#[cfg(feature = "allocation-counters")]
mod allocation_counters {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    pub struct CountingAllocator;

    static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static DEALLOCATIONS: AtomicU64 = AtomicU64::new(0);
    static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);
    static DEALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc(layout) };
            if !ptr.is_null() {
                ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
                ALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
            }
            ptr
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            DEALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            DEALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
            unsafe { System.dealloc(ptr, layout) };
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            DEALLOCATIONS.fetch_add(1, Ordering::Relaxed);
            DEALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
            let new_ptr = unsafe { System.realloc(ptr, layout, new_size) };
            if !new_ptr.is_null() {
                ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
                ALLOCATED_BYTES.fetch_add(new_size, Ordering::Relaxed);
            }
            new_ptr
        }
    }

    #[global_allocator]
    static GLOBAL: CountingAllocator = CountingAllocator;

    pub fn reset() {
        ALLOCATIONS.store(0, Ordering::Relaxed);
        DEALLOCATIONS.store(0, Ordering::Relaxed);
        ALLOCATED_BYTES.store(0, Ordering::Relaxed);
        DEALLOCATED_BYTES.store(0, Ordering::Relaxed);
    }

    pub fn report() -> String {
        let allocations = ALLOCATIONS.load(Ordering::Relaxed);
        let deallocations = DEALLOCATIONS.load(Ordering::Relaxed);
        let allocated_bytes = ALLOCATED_BYTES.load(Ordering::Relaxed);
        let deallocated_bytes = DEALLOCATED_BYTES.load(Ordering::Relaxed);
        format!(
            "allocation_report allocations={allocations} deallocations={deallocations} net_allocations={} allocated_bytes={allocated_bytes} deallocated_bytes={deallocated_bytes} net_bytes={}",
            allocations.saturating_sub(deallocations),
            allocated_bytes.saturating_sub(deallocated_bytes),
        )
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let allocation_report = env::args().any(|arg| arg == "--allocation-report");
    #[cfg(not(feature = "allocation-counters"))]
    if allocation_report {
        eprintln!(
            "allocation_report unavailable: rebuild engine_candidate with --features allocation-counters"
        );
    }
    if env::args().any(|arg| arg == "--stdio-loop") {
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        for line in stdin.lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let request: Value = serde_json::from_str(&line)?;
            #[cfg(feature = "allocation-counters")]
            if allocation_report {
                allocation_counters::reset();
            }
            let response = handle_request(&request)?;
            #[cfg(feature = "allocation-counters")]
            if allocation_report {
                eprintln!("{}", allocation_counters::report());
            }
            writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
            stdout.flush()?;
        }
        return Ok(());
    }

    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    #[cfg(feature = "allocation-counters")]
    if allocation_report {
        allocation_counters::reset();
    }
    let response = handle_request(&request)?;
    #[cfg(feature = "allocation-counters")]
    if allocation_report {
        eprintln!("{}", allocation_counters::report());
    }
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}
