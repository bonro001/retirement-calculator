use chrono::Utc;
use flight_engine::candidate_engine::handle_request;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_DISPATCHER_PORT: u16 = 8765;
const HEARTBEAT_INTERVAL_MS: u64 = 3_000;
const MINING_PROTOCOL_VERSION: &str = "1.0.0";
const CURRENT_YEAR: i64 = 2026;
const ENGINE_RUNTIME: &str = "rust-native-worker";

#[derive(Clone)]
struct ActiveSession {
    session_id: String,
    baseline_fingerprint: String,
    engine_version: String,
    data: Value,
    assumptions: Value,
    legacy_target_today_dollars: f64,
}

#[derive(Clone)]
struct WorkerConfig {
    dispatcher_url: String,
    display_name: String,
    worker_count: usize,
    perf_class: String,
    platform_descriptor: String,
    build_info: Value,
}

type Shared<T> = Arc<Mutex<T>>;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = WorkerConfig::from_env();
    log(
        "info",
        "native worker starting",
        json!({
            "url": config.dispatcher_url,
            "workers": config.worker_count,
            "runtime": ENGINE_RUNTIME,
        }),
    );

    let mut reconnect_attempt = 0usize;
    loop {
        match run_connection(config.clone()).await {
            Ok(()) => reconnect_attempt = 0,
            Err(err) => {
                log("warn", "connection ended", json!({ "error": err.to_string() }));
            }
        }

        let delay = reconnect_delay(reconnect_attempt);
        reconnect_attempt += 1;
        log(
            "info",
            "reconnecting",
            json!({ "inMs": delay.as_millis(), "attempt": reconnect_attempt }),
        );
        tokio::time::sleep(delay).await;
    }
}

async fn run_connection(config: WorkerConfig) -> Result<(), Box<dyn std::error::Error>> {
    let (socket, _) = connect_async(&config.dispatcher_url).await?;
    let (mut writer, mut reader) = socket.split();
    let (send_tx, mut send_rx) = mpsc::unbounded_channel::<Value>();
    let peer_id: Shared<Option<String>> = Arc::new(Mutex::new(None));
    let active_session: Shared<Option<ActiveSession>> = Arc::new(Mutex::new(None));
    let in_flight: Shared<HashSet<String>> = Arc::new(Mutex::new(HashSet::new()));
    let slots = Arc::new(Semaphore::new(config.worker_count));

    let writer_task = tokio::spawn(async move {
        while let Some(message) = send_rx.recv().await {
            let text = match serde_json::to_string(&stamp_message(message)) {
                Ok(text) => text,
                Err(err) => {
                    log("warn", "failed to encode outbound message", json!({ "error": err.to_string() }));
                    continue;
                }
            };
            if let Err(err) = writer.send(Message::Text(text.into())).await {
                log("warn", "failed to send outbound message", json!({ "error": err.to_string() }));
                break;
            }
        }
    });

    send_tx.send(register_message(&config))?;

    let heartbeat_tx = send_tx.clone();
    let heartbeat_peer_id = peer_id.clone();
    let heartbeat_in_flight = in_flight.clone();
    let heartbeat_slots = slots.clone();
    let heartbeat_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
        loop {
            interval.tick().await;
            let from = heartbeat_peer_id.lock().ok().and_then(|guard| guard.clone());
            let Some(from) = from else {
                continue;
            };
            let in_flight_batch_ids = heartbeat_in_flight
                .lock()
                .map(|guard| guard.iter().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let free_worker_slots = heartbeat_slots.available_permits();
            if heartbeat_tx
                .send(json!({
                    "kind": "heartbeat",
                    "from": from,
                    "inFlightBatchIds": in_flight_batch_ids,
                    "freeWorkerSlots": free_worker_slots,
                }))
                .is_err()
            {
                break;
            }
        }
    });

    while let Some(raw) = reader.next().await {
        let raw = raw?;
        if !raw.is_text() {
            continue;
        }
        let message: Value = match serde_json::from_str(raw.to_text()?) {
            Ok(value) => value,
            Err(err) => {
                log("warn", "failed to parse dispatcher message", json!({ "error": err.to_string() }));
                continue;
            }
        };
        handle_message(
            message,
            &config,
            &send_tx,
            peer_id.clone(),
            active_session.clone(),
            in_flight.clone(),
            slots.clone(),
        );
    }

    heartbeat_task.abort();
    writer_task.abort();
    Ok(())
}

fn handle_message(
    message: Value,
    config: &WorkerConfig,
    send_tx: &mpsc::UnboundedSender<Value>,
    peer_id: Shared<Option<String>>,
    active_session: Shared<Option<ActiveSession>>,
    in_flight: Shared<HashSet<String>>,
    slots: Arc<Semaphore>,
) {
    let kind = message.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "welcome" => {
            let new_peer_id = message
                .get("peerId")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            if let Ok(mut guard) = peer_id.lock() {
                *guard = Some(new_peer_id.clone());
            }
            log(
                "info",
                "welcomed",
                json!({
                    "peerId": new_peer_id,
                    "clusterPeers": message.pointer("/clusterSnapshot/peers").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                }),
            );
        }
        "register_rejected" => {
            log(
                "error",
                "register rejected",
                json!({
                    "reason": message.get("reason").and_then(Value::as_str).unwrap_or("unknown"),
                    "detail": message.get("detail").and_then(Value::as_str).unwrap_or(""),
                }),
            );
        }
        "start_session" => {
            let config_value = message.get("config").cloned().unwrap_or_else(|| json!({}));
            let session_id = message
                .get("sessionId")
                .and_then(Value::as_str)
                .or_else(|| config_value.get("baselineFingerprint").and_then(Value::as_str))
                .unwrap_or("unknown-session")
                .to_string();
            let session = ActiveSession {
                session_id: session_id.clone(),
                baseline_fingerprint: config_value
                    .get("baselineFingerprint")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown-baseline")
                    .to_string(),
                engine_version: config_value
                    .get("engineVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown-engine")
                    .to_string(),
                data: message.get("seedDataPayload").cloned().unwrap_or_else(|| json!({})),
                assumptions: message
                    .get("marketAssumptionsPayload")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                legacy_target_today_dollars: message
                    .get("legacyTargetTodayDollars")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            };
            if let Ok(mut guard) = active_session.lock() {
                *guard = Some(session);
            }
            if let Ok(mut guard) = in_flight.lock() {
                guard.clear();
            }
            log(
                "info",
                "session started",
                json!({
                    "sessionId": session_id,
                    "baseline": config_value.get("baselineFingerprint").and_then(Value::as_str).unwrap_or("unknown"),
                    "engine": config_value.get("engineVersion").and_then(Value::as_str).unwrap_or("unknown"),
                    "trials": message.get("trialCount").and_then(Value::as_i64).unwrap_or(0),
                }),
            );
        }
        "cancel_session" => {
            let cancelled_session_id = message.get("sessionId").and_then(Value::as_str).unwrap_or("");
            if let Ok(mut guard) = active_session.lock() {
                if guard
                    .as_ref()
                    .map(|session| session.session_id.as_str() == cancelled_session_id)
                    .unwrap_or(false)
                {
                    *guard = None;
                }
            }
            if let Ok(mut guard) = in_flight.lock() {
                guard.clear();
            }
            log("info", "session cancelled", json!({ "sessionId": cancelled_session_id }));
        }
        "batch_assign" => {
            let Some(batch) = message.get("batch").cloned() else {
                return;
            };
            let session_id = message
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let batch_id = batch
                .get("batchId")
                .and_then(Value::as_str)
                .unwrap_or("unknown-batch")
                .to_string();
            let session = active_session.lock().ok().and_then(|guard| guard.clone());
            let Some(session) = session else {
                send_nack(send_tx, &peer_id, &session_id, &batch_id, "no_active_session");
                return;
            };
            if session.session_id != session_id {
                send_nack(send_tx, &peer_id, &session_id, &batch_id, "inactive_session");
                return;
            }
            if batch.get("engineVersion").and_then(Value::as_str) != Some(session.engine_version.as_str()) {
                send_nack(send_tx, &peer_id, &session_id, &batch_id, "engine_version_mismatch");
                return;
            }
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                send_nack(send_tx, &peer_id, &session_id, &batch_id, "host_no_free_slots");
                return;
            };
            if let Ok(mut guard) = in_flight.lock() {
                guard.insert(batch_id.clone());
            }

            let task_tx = send_tx.clone();
            let task_peer_id = peer_id.clone();
            let task_in_flight = in_flight.clone();
            let task_config = config.clone();
            tokio::spawn(async move {
                let started_at = Instant::now();
                let result = tokio::task::spawn_blocking(move || {
                    run_batch(&session, &batch, &task_config)
                })
                .await
                .unwrap_or_else(|err| Err(format!("worker task panicked: {err}")));
                drop(permit);

                let (mut evaluations, partial_failure) = match result {
                    Ok(evaluations) => (evaluations, Value::Null),
                    Err(reason) => {
                        log("warn", "batch failed", json!({ "batchId": batch_id, "reason": reason }));
                        (
                            Vec::new(),
                            json!({
                                "completedPolicyIds": [],
                                "reason": reason,
                            }),
                        )
                    }
                };
                let evaluated_by_node_id = task_peer_id
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone())
                    .unwrap_or_else(|| "unknown".to_string());
                for evaluation in evaluations.iter_mut() {
                    evaluation["evaluatedByNodeId"] = Value::String(evaluated_by_node_id.clone());
                }
                let _ = task_tx.send(json!({
                    "kind": "batch_result",
                    "from": evaluated_by_node_id,
                    "sessionId": session_id,
                    "result": {
                        "batchId": batch_id,
                        "evaluatedByNodeId": evaluated_by_node_id,
                        "batchDurationMs": started_at.elapsed().as_millis() as u64,
                        "evaluations": evaluations,
                        "partialFailure": partial_failure,
                    }
                }));
                if let Ok(mut guard) = task_in_flight.lock() {
                    // The dispatcher also sends batch_ack; removing here keeps the
                    // heartbeat honest if an ack is delayed or lost after result send.
                    guard.remove(&batch_id);
                }
                log(
                    "info",
                    "batch done",
                    json!({
                        "batchId": batch_id,
                        "policies": evaluations.len(),
                        "durationMs": started_at.elapsed().as_millis() as u64,
                    }),
                );
            });
        }
        "batch_ack" => {
            let batch_id = message.get("batchId").and_then(Value::as_str).unwrap_or("");
            if let Ok(mut guard) = in_flight.lock() {
                guard.remove(batch_id);
            }
        }
        _ => {}
    }
}

fn run_batch(
    session: &ActiveSession,
    batch: &Value,
    config: &WorkerConfig,
) -> Result<Vec<Value>, String> {
    let policies = batch
        .get("policies")
        .and_then(Value::as_array)
        .ok_or_else(|| "batch is missing policies[]".to_string())?;
    let trial_count = batch
        .get("trialCount")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| as_i64(session.assumptions.get("simulationRuns")))
        .max(1);

    policies
        .iter()
        .map(|policy| evaluate_policy(session, policy, trial_count, config))
        .collect()
}

fn evaluate_policy(
    session: &ActiveSession,
    policy: &Value,
    trial_count: i64,
    _config: &WorkerConfig,
) -> Result<Value, String> {
    let started_at = Instant::now();
    let mut candidate_data = session.data.clone();
    apply_policy_to_seed(&mut candidate_data, policy);
    let mut candidate_assumptions = session.assumptions.clone();
    if let Some(rule) = policy.get("withdrawalRule").and_then(Value::as_str) {
        candidate_assumptions["withdrawalRule"] = Value::String(rule.to_string());
    }
    candidate_assumptions["simulationRuns"] = json!(trial_count);

    let tape = build_policy_mining_random_tape(&candidate_data, &candidate_assumptions, policy)?;
    let request = json!({
        "schemaVersion": "engine-candidate-request-v1",
        "data": candidate_data,
        "assumptions": candidate_assumptions,
        "mode": tape.get("simulationMode").and_then(Value::as_str).unwrap_or("planner_enhanced"),
        "tape": tape,
        "annualSpendTarget": policy.get("annualSpendTodayDollars").and_then(Value::as_f64).unwrap_or(0.0),
        "outputLevel": "policy_mining_summary",
    });
    let response = handle_request(&request).map_err(|err| err.to_string())?;
    let summary = response
        .get("summary")
        .cloned()
        .ok_or_else(|| "Rust engine response missing summary".to_string())?;
    Ok(build_policy_evaluation_from_summary(
        policy,
        &summary,
        &candidate_assumptions,
        session,
        started_at.elapsed().as_millis() as u64,
    ))
}

fn apply_policy_to_seed(seed: &mut Value, policy: &Value) {
    if let Some(claim_age) = policy.get("primarySocialSecurityClaimAge").and_then(Value::as_f64) {
        seed.pointer_mut("/income/socialSecurity/0/claimAge")
            .map(|slot| *slot = json!(claim_age));
    }
    if !policy.get("spouseSocialSecurityClaimAge").unwrap_or(&Value::Null).is_null() {
        if let Some(claim_age) = policy.get("spouseSocialSecurityClaimAge").and_then(Value::as_f64) {
            seed.pointer_mut("/income/socialSecurity/1/claimAge")
                .map(|slot| *slot = json!(claim_age));
        }
    }
    let roth_ceiling = policy
        .get("rothConversionAnnualCeiling")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if let Some(rules) = seed.get_mut("rules").and_then(Value::as_object_mut) {
        rules.insert(
            "rothConversionPolicy".to_string(),
            json!({
                "enabled": roth_ceiling > 0.0,
                "minAnnualDollars": 0,
                "magiBufferDollars": roth_ceiling,
            }),
        );
    }
}

fn build_policy_mining_random_tape(
    data: &Value,
    assumptions: &Value,
    policy: &Value,
) -> Result<Value, String> {
    let simulation_mode = "planner_enhanced";
    let simulation_seed = as_i64(assumptions.get("simulationSeed")).max(0) as u32;
    let trial_count = as_i64(assumptions.get("simulationRuns")).max(1);
    let assumptions_version = assumptions
        .get("assumptionsVersion")
        .and_then(Value::as_str)
        .unwrap_or("v1");
    let horizon_years = retirement_horizon_years(data, assumptions) + 1;
    let policy_id_for_label = policy_id(
        policy,
        "native-label",
        assumptions_version,
    );
    let use_historical_bootstrap = assumptions
        .get("useHistoricalBootstrap")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let use_correlated_returns = assumptions
        .get("useCorrelatedReturns")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let bootstrap_block_length = as_i64(assumptions.get("historicalBootstrapBlockLength")).max(1);
    let equity_tail_mode = assumptions
        .get("equityTailMode")
        .and_then(Value::as_str)
        .unwrap_or("normal");
    let ltc_enabled = data
        .pointer("/rules/ltcAssumptions/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let ltc_event_probability = data
        .pointer("/rules/ltcAssumptions/eventProbability")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);

    let mut trials = Vec::with_capacity(trial_count as usize);
    for trial_index in 0..trial_count {
        let trial_seed = mix_seed(simulation_seed, trial_index as u32 + 1);
        let mut random = SeededRandom::new(trial_seed);
        let block_indices = if use_historical_bootstrap && bootstrap_block_length > 1 {
            Some(build_block_bootstrap_index_sequence(
                horizon_years as usize,
                bootstrap_block_length as usize,
                &mut random,
            ))
        } else {
            None
        };
        let mut market_path = Vec::with_capacity(horizon_years as usize);
        for year_offset in 0..horizon_years {
            let presampled_index = block_indices
                .as_ref()
                .and_then(|indices| indices.get(year_offset as usize).copied());
            let point = market_returns(
                assumptions,
                &mut random,
                use_historical_bootstrap,
                use_correlated_returns,
                equity_tail_mode,
                presampled_index,
            );
            let asset_returns = AssetReturns {
                us_equity: point.us_equity,
                intl_equity: point.intl_equity,
                bonds: point.bonds,
                cash: point.cash,
            };
            market_path.push(json!({
                "year": CURRENT_YEAR + year_offset,
                "yearOffset": year_offset,
                "inflation": point.inflation,
                "assetReturns": {
                    "US_EQUITY": point.us_equity,
                    "INTL_EQUITY": point.intl_equity,
                    "BONDS": point.bonds,
                    "CASH": point.cash,
                },
                "bucketReturns": {
                    "pretax": bucket_return_from_parts(data, "pretax", asset_returns),
                    "roth": bucket_return_from_parts(data, "roth", asset_returns),
                    "taxable": bucket_return_from_parts(data, "taxable", asset_returns),
                    "cash": bucket_return_from_parts(data, "cash", asset_returns),
                },
                "cashflow": {},
                "marketState": point.market_state,
            }));
        }
        let ltc_event_occurs = ltc_enabled && random.next() < ltc_event_probability;
        trials.push(json!({
            "trialIndex": trial_index,
            "trialSeed": trial_seed,
            "ltcEventOccurs": ltc_event_occurs,
            "marketPath": market_path,
        }));
    }

    Ok(json!({
        "schemaVersion": "retirement-random-tape-v1",
        "generatedBy": "rust-native-worker",
        "createdAtIso": Utc::now().to_rfc3339(),
        "label": format!("policy-miner:{policy_id_for_label}"),
        "simulationMode": simulation_mode,
        "seed": simulation_seed,
        "trialCount": trial_count,
        "planningHorizonYears": horizon_years,
        "assumptionsVersion": assumptions_version,
        "samplingStrategy": assumptions.get("samplingStrategy").and_then(Value::as_str).unwrap_or("mc"),
        "returnModel": {
            "useHistoricalBootstrap": use_historical_bootstrap,
            "historicalBootstrapBlockLength": bootstrap_block_length,
            "useCorrelatedReturns": use_correlated_returns,
            "equityTailMode": equity_tail_mode,
        },
        "trials": trials,
    }))
}

fn build_policy_evaluation_from_summary(
    policy: &Value,
    summary: &Value,
    assumptions: &Value,
    session: &ActiveSession,
    evaluation_duration_ms: u64,
) -> Value {
    let horizon_years = summary
        .pointer("/monteCarloMetadata/planningHorizonYears")
        .and_then(Value::as_f64)
        .unwrap_or(30.0);
    let inflation = assumptions
        .get("inflation")
        .and_then(Value::as_f64)
        .unwrap_or(0.025);
    let p10 = deflate(summary.pointer("/endingWealthPercentiles/p10"), inflation, horizon_years);
    let p25 = deflate(summary.pointer("/endingWealthPercentiles/p25"), inflation, horizon_years);
    let p50 = deflate(summary.pointer("/endingWealthPercentiles/p50"), inflation, horizon_years);
    let p75 = deflate(summary.pointer("/endingWealthPercentiles/p75"), inflation, horizon_years);
    let p90 = deflate(summary.pointer("/endingWealthPercentiles/p90"), inflation, horizon_years);
    json!({
        "evaluatedByNodeId": "rust-native-worker",
        "id": policy_id(policy, &session.baseline_fingerprint, &session.engine_version),
        "baselineFingerprint": session.baseline_fingerprint,
        "engineVersion": session.engine_version,
        "evaluatedAtIso": Utc::now().to_rfc3339(),
        "policy": policy,
        "outcome": {
            "solventSuccessRate": summary.get("successRate").and_then(Value::as_f64).unwrap_or(0.0),
            "bequestAttainmentRate": approximate_bequest_attainment_rate(
                session.legacy_target_today_dollars,
                [p10, p25, p50, p75, p90],
            ),
            "p10EndingWealthTodayDollars": p10,
            "p25EndingWealthTodayDollars": p25,
            "p50EndingWealthTodayDollars": p50,
            "p75EndingWealthTodayDollars": p75,
            "p90EndingWealthTodayDollars": p90,
            "medianLifetimeSpendTodayDollars": 0,
            "medianSpendVolatility": 0,
            "medianLifetimeFederalTaxTodayDollars": summary.get("annualFederalTaxEstimate").and_then(Value::as_f64).unwrap_or(0.0),
            "irmaaExposureRate": summary.get("irmaaExposureRate").and_then(Value::as_f64).unwrap_or(0.0),
        },
        "evaluationDurationMs": evaluation_duration_ms,
    })
}

#[derive(Clone, Copy)]
struct AssetReturns {
    us_equity: f64,
    intl_equity: f64,
    bonds: f64,
    cash: f64,
}

#[derive(Clone, Copy)]
struct MarketPoint {
    inflation: f64,
    us_equity: f64,
    intl_equity: f64,
    bonds: f64,
    cash: f64,
    market_state: &'static str,
}

fn market_returns(
    assumptions: &Value,
    random: &mut SeededRandom,
    use_historical_bootstrap: bool,
    use_correlated_returns: bool,
    equity_tail_mode: &str,
    presampled_bootstrap_index: Option<usize>,
) -> MarketPoint {
    if use_historical_bootstrap {
        let row = historical_row(presampled_bootstrap_index.unwrap_or_else(|| {
            (random.next() * historical_rows().len() as f64).floor() as usize
        }));
        return MarketPoint {
            inflation: row.inflation,
            us_equity: row.stocks,
            intl_equity: row.stocks * 0.95,
            bonds: row.bonds,
            cash: (row.inflation * 0.8).max(0.0),
            market_state: "normal",
        };
    }

    let inflation = bounded_normal(
        as_f64_default(assumptions.get("inflation"), 0.028),
        as_f64_default(assumptions.get("inflationVolatility"), 0.01),
        -0.02,
        0.12,
        random,
    );
    let use_crash_mixture = equity_tail_mode == "crash_mixture";
    let is_crash_year = use_crash_mixture && random.next() < 0.03;
    let us_mean = if use_crash_mixture {
        adjust_equity_mean_for_crash_mixture(as_f64_default(assumptions.get("equityMean"), 0.074))
    } else {
        as_f64_default(assumptions.get("equityMean"), 0.074)
    };
    let intl_mean = if use_crash_mixture {
        adjust_equity_mean_for_crash_mixture(as_f64_default(
            assumptions.get("internationalEquityMean"),
            0.074,
        ))
    } else {
        as_f64_default(assumptions.get("internationalEquityMean"), 0.074)
    };

    if is_crash_year {
        const CRASH_RETURNS: [f64; 5] = [-0.438, -0.370, -0.350, -0.265, -0.221];
        let idx = (random.next() * CRASH_RETURNS.len() as f64).floor() as usize;
        let crash_return = CRASH_RETURNS[idx.min(CRASH_RETURNS.len() - 1)];
        return MarketPoint {
            inflation,
            us_equity: crash_return,
            intl_equity: crash_return,
            bonds: bounded_normal(
                as_f64_default(assumptions.get("bondMean"), 0.038),
                as_f64_default(assumptions.get("bondVolatility"), 0.07),
                -0.2,
                0.2,
                random,
            ),
            cash: bounded_normal(
                as_f64_default(assumptions.get("cashMean"), 0.02),
                as_f64_default(assumptions.get("cashVolatility"), 0.01),
                -0.01,
                0.08,
                random,
            ),
            market_state: "normal",
        };
    }

    if use_correlated_returns {
        let [us_equity, intl_equity, bonds, cash] = correlated_asset_returns(
            [
                (us_mean, as_f64_default(assumptions.get("equityVolatility"), 0.16), -0.45, 0.45),
                (
                    intl_mean,
                    as_f64_default(assumptions.get("internationalEquityVolatility"), 0.18),
                    -0.5,
                    0.45,
                ),
                (
                    as_f64_default(assumptions.get("bondMean"), 0.038),
                    as_f64_default(assumptions.get("bondVolatility"), 0.07),
                    -0.2,
                    0.2,
                ),
                (
                    as_f64_default(assumptions.get("cashMean"), 0.02),
                    as_f64_default(assumptions.get("cashVolatility"), 0.01),
                    -0.01,
                    0.08,
                ),
            ],
            random,
        );
        return MarketPoint {
            inflation,
            us_equity,
            intl_equity,
            bonds,
            cash,
            market_state: "normal",
        };
    }

    MarketPoint {
        inflation,
        us_equity: bounded_normal(us_mean, as_f64_default(assumptions.get("equityVolatility"), 0.16), -0.45, 0.45, random),
        intl_equity: bounded_normal(intl_mean, as_f64_default(assumptions.get("internationalEquityVolatility"), 0.18), -0.5, 0.45, random),
        bonds: bounded_normal(as_f64_default(assumptions.get("bondMean"), 0.038), as_f64_default(assumptions.get("bondVolatility"), 0.07), -0.2, 0.2, random),
        cash: bounded_normal(as_f64_default(assumptions.get("cashMean"), 0.02), as_f64_default(assumptions.get("cashVolatility"), 0.01), -0.01, 0.08, random),
        market_state: "normal",
    }
}

fn correlated_asset_returns(
    specs: [(f64, f64, f64, f64); 4],
    random: &mut SeededRandom,
) -> [f64; 4] {
    let z0 = gaussian_random(random);
    let z1 = gaussian_random(random);
    let z2 = gaussian_random(random);
    let z3 = gaussian_random(random);
    let x0 = z0;
    let x1 = 0.85 * z0 + 0.52678 * z1;
    let x2 = 0.15 * z0 + -0.05221 * z1 + 0.98729 * z2;
    let x3 = 0.20258 * z2 + 0.97927 * z3;
    [x0, x1, x2, x3]
        .into_iter()
        .enumerate()
        .map(|(index, z)| {
            let (mean, std_dev, min, max) = specs[index];
            (mean + z * std_dev).clamp(min, max)
        })
        .collect::<Vec<_>>()
        .try_into()
        .unwrap_or([0.0, 0.0, 0.0, 0.0])
}

fn build_block_bootstrap_index_sequence(
    horizon_years: usize,
    block_length: usize,
    random: &mut SeededRandom,
) -> Vec<usize> {
    let fixture_len = historical_rows().len();
    let mut sequence = Vec::with_capacity(horizon_years);
    while sequence.len() < horizon_years {
        let start = (random.next() * fixture_len as f64).floor() as usize;
        for i in 0..block_length {
            if sequence.len() >= horizon_years {
                break;
            }
            sequence.push((start + i) % fixture_len);
        }
    }
    sequence
}

#[derive(Clone, Copy)]
struct HistoricalRow {
    stocks: f64,
    bonds: f64,
    inflation: f64,
}

fn historical_rows() -> &'static Vec<HistoricalRow> {
    static ROWS: OnceLock<Vec<HistoricalRow>> = OnceLock::new();
    ROWS.get_or_init(|| {
        let value: Value = serde_json::from_str(include_str!("../../../fixtures/historical_annual_returns.json"))
            .expect("historical annual returns fixture should parse");
        value
            .get("annual")
            .and_then(Value::as_array)
            .expect("historical annual returns fixture should contain annual[]")
            .iter()
            .map(|row| HistoricalRow {
                stocks: row.get("stocks").and_then(Value::as_f64).unwrap_or(0.0),
                bonds: row.get("bonds").and_then(Value::as_f64).unwrap_or(0.0),
                inflation: row.get("inflation").and_then(Value::as_f64).unwrap_or(0.0),
            })
            .collect()
    })
}

fn historical_row(index: usize) -> HistoricalRow {
    let rows = historical_rows();
    rows[index.min(rows.len().saturating_sub(1))]
}

struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 0x6d2b79f5 } else { seed },
        }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

fn mix_seed(seed: u32, offset: u32) -> u32 {
    let mut value = seed ^ offset.wrapping_mul(0x9e3779b9);
    value ^= value >> 16;
    value = value.wrapping_mul(0x85ebca6b);
    value ^= value >> 13;
    value = value.wrapping_mul(0xc2b2ae35);
    value ^= value >> 16;
    value
}

fn gaussian_random(random: &mut SeededRandom) -> f64 {
    let mut first = 0.0;
    let mut second = 0.0;
    while first == 0.0 {
        first = random.next();
    }
    while second == 0.0 {
        second = random.next();
    }
    (-2.0 * first.ln()).sqrt() * (2.0 * std::f64::consts::PI * second).cos()
}

fn bounded_normal(mean: f64, std_dev: f64, min: f64, max: f64, random: &mut SeededRandom) -> f64 {
    (mean + gaussian_random(random) * std_dev).clamp(min, max)
}

fn adjust_equity_mean_for_crash_mixture(original_mean: f64) -> f64 {
    const CRASH_MEAN: f64 = (-0.438 - 0.370 - 0.350 - 0.265 - 0.221) / 5.0;
    (original_mean - 0.03 * CRASH_MEAN) / (1.0 - 0.03)
}

fn bucket_return_from_parts(data: &Value, bucket: &str, asset_returns: AssetReturns) -> f64 {
    data.pointer(&format!("/accounts/{bucket}/targetAllocation"))
        .and_then(Value::as_object)
        .map(|allocation| {
            allocation.iter().fold(0.0, |total, (symbol, weight)| {
                let weight = weight.as_f64().unwrap_or(0.0);
                let (us_w, intl_w, bonds_w, cash_w) = symbol_exposure(symbol);
                total
                    + weight
                        * (us_w * asset_returns.us_equity
                            + intl_w * asset_returns.intl_equity
                            + bonds_w * asset_returns.bonds
                            + cash_w * asset_returns.cash)
            })
        })
        .unwrap_or(0.0)
}

fn symbol_exposure(symbol: &str) -> (f64, f64, f64, f64) {
    match symbol {
        "CASH" => (0.0, 0.0, 0.0, 1.0),
        "BND" | "MUB" | "FSRIX" => (0.0, 0.0, 1.0, 0.0),
        "VXUS" | "IEFA" | "IEMG" => (0.0, 1.0, 0.0, 0.0),
        "TRP_2030" => (0.42, 0.18, 0.37, 0.03),
        "CENTRAL_MANAGED" => (0.45, 0.12, 0.35, 0.08),
        _ => (1.0, 0.0, 0.0, 0.0),
    }
}

fn retirement_horizon_years(data: &Value, assumptions: &Value) -> i64 {
    let rob_age = current_age_at_2026_04_16(
        data.pointer("/household/robBirthDate")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let debbie_age = current_age_at_2026_04_16(
        data.pointer("/household/debbieBirthDate")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let default_target = as_i64(data.pointer("/household/planningAge"));
    let rob_target = as_i64_default(assumptions.get("robPlanningEndAge"), default_target);
    let debbie_target = as_i64_default(assumptions.get("debbiePlanningEndAge"), default_target);
    (rob_target - rob_age).max(debbie_target - debbie_age).max(0)
}

fn current_age_at_2026_04_16(birth_date: &str) -> i64 {
    let birth_year = year_from_iso(birth_date);
    let birth_month = birth_date
        .get(5..7)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(1);
    let birth_day = birth_date
        .get(8..10)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(1);
    let had_birthday = birth_month < 4 || (birth_month == 4 && birth_day <= 16);
    CURRENT_YEAR - birth_year - if had_birthday { 0 } else { 1 }
}

fn year_from_iso(value: &str) -> i64 {
    value.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn deflate(value: Option<&Value>, inflation: f64, horizon_years: f64) -> f64 {
    let nominal = value.and_then(Value::as_f64).unwrap_or(0.0);
    let factor = (1.0 + inflation.max(-0.99)).powf(horizon_years.max(0.0));
    if factor <= 0.0 { nominal } else { nominal / factor }
}

fn approximate_bequest_attainment_rate(target: f64, dist: [f64; 5]) -> f64 {
    if !target.is_finite() || target <= 0.0 {
        return 1.0;
    }
    let knots = [
        (dist[0], 0.9),
        (dist[1], 0.75),
        (dist[2], 0.5),
        (dist[3], 0.25),
        (dist[4], 0.1),
    ];
    if target < knots[0].0 {
        return 0.99;
    }
    if target > knots[4].0 {
        return 0.01;
    }
    for pair in knots.windows(2) {
        let (a_value, a_above) = pair[0];
        let (b_value, b_above) = pair[1];
        if target >= a_value && target <= b_value {
            let span = b_value - a_value;
            if span <= 0.0 {
                return a_above;
            }
            let frac = (target - a_value) / span;
            return a_above + frac * (b_above - a_above);
        }
    }
    0.5
}

fn policy_id(policy: &Value, baseline_fingerprint: &str, engine_version: &str) -> String {
    let canonical = format!(
        "{{\"a\":{},\"p\":{},\"s\":{},\"r\":{},\"w\":\"{}\",\"b\":\"{}\",\"e\":\"{}\"}}",
        js_number(policy.get("annualSpendTodayDollars").and_then(Value::as_f64).unwrap_or(0.0)),
        js_number(policy.get("primarySocialSecurityClaimAge").and_then(Value::as_f64).unwrap_or(0.0)),
        policy
            .get("spouseSocialSecurityClaimAge")
            .and_then(Value::as_f64)
            .map(js_number)
            .unwrap_or_else(|| "null".to_string()),
        js_number(policy.get("rothConversionAnnualCeiling").and_then(Value::as_f64).unwrap_or(0.0)),
        escape_json_string(policy.get("withdrawalRule").and_then(Value::as_str).unwrap_or("tax_bracket_waterfall")),
        escape_json_string(baseline_fingerprint),
        escape_json_string(engine_version),
    );
    let mut hash = 0x811c9dc5u32;
    for unit in canonical.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("pol_{hash:08x}")
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let mut text = format!("{value}");
        if text.contains('e') || text.contains('E') {
            text = format!("{value:.12}");
        }
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn escape_json_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".to_string())
        .trim_matches('"')
        .to_string()
}

fn as_f64_default(value: Option<&Value>, default: f64) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(default)
}

fn as_i64(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

fn as_i64_default(value: Option<&Value>, default: i64) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(default)
}

fn register_message(config: &WorkerConfig) -> Value {
    json!({
        "kind": "register",
        "protocolVersion": MINING_PROTOCOL_VERSION,
        "roles": ["host"],
        "displayName": config.display_name,
        "buildInfo": config.build_info,
        "capabilities": {
            "workerCount": config.worker_count,
            "perfClass": config.perf_class,
            "platformDescriptor": config.platform_descriptor,
            "engineRuntime": ENGINE_RUNTIME,
        },
    })
}

fn send_nack(
    send_tx: &mpsc::UnboundedSender<Value>,
    peer_id: &Shared<Option<String>>,
    session_id: &str,
    batch_id: &str,
    reason: &str,
) {
    let from = peer_id.lock().ok().and_then(|guard| guard.clone());
    let _ = send_tx.send(json!({
        "kind": "batch_nack",
        "from": from,
        "sessionId": session_id,
        "batchId": batch_id,
        "reason": reason,
    }));
}

fn stamp_message(mut message: Value) -> Value {
    if let Some(object) = message.as_object_mut() {
        object.entry("ts".to_string()).or_insert_with(|| {
            json!(std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0))
        });
    }
    message
}

impl WorkerConfig {
    fn from_env() -> Self {
        let dispatcher_url =
            env::var("DISPATCHER_URL").unwrap_or_else(|_| format!("ws://localhost:{DEFAULT_DISPATCHER_PORT}"));
        let host_name = local_hostname();
        let display_name =
            env::var("HOST_DISPLAY_NAME").unwrap_or_else(|_| format!("rust-worker-{host_name}"));
        let cpu_count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        let default_workers = cpu_count.saturating_sub(2).clamp(1, 12);
        let worker_count = env::var("HOST_WORKERS")
            .ok()
            .and_then(|raw| raw.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default_workers);
        let perf_class = env::var("HOST_PERF_CLASS").unwrap_or_else(|_| {
            if cfg!(target_arch = "aarch64") {
                "apple-silicon-perf".to_string()
            } else if cfg!(target_arch = "x86_64") {
                "x86-modern".to_string()
            } else {
                "unknown".to_string()
            }
        });
        let platform_descriptor = env::var("HOST_PLATFORM_DESCRIPTOR").unwrap_or_else(|_| {
            format!("{}-{}-{}cpu", env::consts::OS, env::consts::ARCH, cpu_count)
        });
        let build_info = env::var("HOST_BUILD_INFO_JSON")
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(local_build_info);
        Self {
            dispatcher_url,
            display_name,
            worker_count,
            perf_class,
            platform_descriptor,
            build_info,
        }
    }
}

fn local_build_info() -> Value {
    let git_commit = git(&["rev-parse", "--short=12", "HEAD"]);
    let git_branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]);
    let git_upstream = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let git_upstream_commit = if git_upstream.is_some() {
        git(&["rev-parse", "--short=12", "@{u}"])
    } else {
        None
    };
    let dirty_files = git(&["status", "--porcelain", "--untracked-files=no"])
        .map(|status| {
            status
                .lines()
                .filter_map(|line| line.get(3..).map(str::trim).filter(|s| !s.is_empty()))
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "packageVersion": env!("CARGO_PKG_VERSION"),
        "gitBranch": git_branch,
        "gitCommit": git_commit,
        "gitDirty": !dirty_files.is_empty(),
        "gitDirtyFiles": dirty_files,
        "gitUpstream": git_upstream,
        "gitUpstreamCommit": git_upstream_commit,
        "source": if git(&["rev-parse", "--short=12", "HEAD"]).is_some() { "git" } else { "unknown" },
    })
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn local_hostname() -> String {
    env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            Command::new("hostname")
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "unknown-host".to_string())
}

fn reconnect_delay(attempt: usize) -> Duration {
    const DELAYS: [u64; 6] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
    Duration::from_millis(DELAYS[attempt.min(DELAYS.len() - 1)])
}

fn log(level: &str, message: &str, meta: Value) {
    eprintln!(
        "[retirement-worker] [{level}] {message} {}",
        serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string())
    );
}
