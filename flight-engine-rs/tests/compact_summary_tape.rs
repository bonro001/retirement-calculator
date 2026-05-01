use flight_engine::candidate_engine::{
    compact_summary_tape_to_json, CompactSummaryTapeInput, COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT,
};
use serde_json::json;

#[test]
fn compact_summary_tape_round_trips_to_json_shape() {
    let metadata = json!({
        "schemaVersion": "retirement-random-tape-v1",
        "generatedBy": "typescript",
        "createdAtIso": "2026-05-01T00:00:00.000Z",
        "label": "rust-compact-unit-test",
        "simulationMode": "raw_simulation",
        "seed": 1,
        "trialCount": 1,
        "planningHorizonYears": 1,
        "assumptionsVersion": "rust-compact-unit-test",
        "samplingStrategy": "mc",
        "returnModel": {
            "useHistoricalBootstrap": false,
            "historicalBootstrapBlockLength": 1,
            "useCorrelatedReturns": false,
            "equityTailMode": "normal"
        }
    });
    let trial_index = [0];
    let trial_seed = [1.0];
    let ltc_event_occurs = [0];
    let cashflow_present = [1];
    let market_state = [0];
    let market_years = [
        2026.0, 0.0, 0.02, 0.05, 0.04, 0.03, 0.01, 0.04, 0.05, 0.03, 0.01,
    ];
    let input = CompactSummaryTapeInput {
        metadata,
        trial_index: &trial_index,
        trial_seed: &trial_seed,
        ltc_event_occurs: &ltc_event_occurs,
        cashflow_present: &cashflow_present,
        market_state: &market_state,
        market_years: &market_years,
        year_field_count: COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT,
    };

    let tape = compact_summary_tape_to_json(input).expect("compact tape should materialize");
    let first_year = &tape["trials"][0]["marketPath"][0];

    assert_eq!(tape["trialCount"], 1);
    assert_eq!(first_year["year"], 2026);
    assert_eq!(first_year["cashflow"], json!({}));
    assert_eq!(first_year["assetReturns"]["US_EQUITY"], 0.05);
    assert_eq!(first_year["bucketReturns"]["pretax"], 0.04);
    assert_eq!(first_year["marketState"], "normal");
}

#[test]
fn compact_summary_tape_rejects_mismatched_dimensions() {
    let metadata = json!({
        "trialCount": 2,
        "planningHorizonYears": 1
    });
    let trial_index = [0];
    let empty_f64: [f64; 0] = [];
    let empty_u8: [u8; 0] = [];
    let input = CompactSummaryTapeInput {
        metadata,
        trial_index: &trial_index,
        trial_seed: &empty_f64,
        ltc_event_occurs: &empty_u8,
        cashflow_present: &empty_u8,
        market_state: &empty_u8,
        market_years: &empty_f64,
        year_field_count: COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT,
    };

    let error = compact_summary_tape_to_json(input).expect_err("dimensions should fail");
    assert!(error.contains("trial arrays do not match trialCount"));
}
