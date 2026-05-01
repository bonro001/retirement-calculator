use crate::candidate_engine::{
    handle_request, handle_request_with_compact_summary_tape, CompactSummaryTapeInput,
    COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT,
};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::ptr;
use std::sync::{Mutex, OnceLock};

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type NapiCallbackInfo = *mut c_void;
type NapiStatus = i32;
type NapiCallback = unsafe extern "C" fn(NapiEnv, NapiCallbackInfo) -> NapiValue;

const NAPI_OK: NapiStatus = 0;
const NAPI_UINT8_ARRAY: i32 = 1;
const NAPI_INT32_ARRAY: i32 = 5;
const NAPI_FLOAT64_ARRAY: i32 = 8;

struct OwnedCompactSummaryTape {
    metadata: Value,
    trial_index: Vec<i32>,
    trial_seed: Vec<f64>,
    ltc_event_occurs: Vec<u8>,
    cashflow_present: Vec<u8>,
    market_state: Vec<u8>,
    market_years: Vec<f64>,
    year_field_count: usize,
}

impl OwnedCompactSummaryTape {
    fn as_input(&self) -> CompactSummaryTapeInput<'_> {
        CompactSummaryTapeInput {
            metadata: self.metadata.clone(),
            trial_index: &self.trial_index,
            trial_seed: &self.trial_seed,
            ltc_event_occurs: &self.ltc_event_occurs,
            cashflow_present: &self.cashflow_present,
            market_state: &self.market_state,
            market_years: &self.market_years,
            year_field_count: self.year_field_count,
        }
    }
}

static COMPACT_TAPE_SESSIONS: OnceLock<Mutex<HashMap<String, OwnedCompactSummaryTape>>> =
    OnceLock::new();

fn compact_tape_sessions() -> &'static Mutex<HashMap<String, OwnedCompactSummaryTape>> {
    COMPACT_TAPE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[repr(C)]
struct NapiPropertyDescriptor {
    utf8name: *const c_char,
    name: NapiValue,
    method: Option<NapiCallback>,
    getter: Option<NapiCallback>,
    setter: Option<NapiCallback>,
    value: NapiValue,
    attributes: i32,
    data: *mut c_void,
}

extern "C" {
    fn napi_get_cb_info(
        env: NapiEnv,
        cbinfo: NapiCallbackInfo,
        argc: *mut usize,
        argv: *mut NapiValue,
        this_arg: *mut NapiValue,
        data: *mut *mut c_void,
    ) -> NapiStatus;

    fn napi_get_value_string_utf8(
        env: NapiEnv,
        value: NapiValue,
        buf: *mut c_char,
        bufsize: usize,
        result: *mut usize,
    ) -> NapiStatus;

    fn napi_create_string_utf8(
        env: NapiEnv,
        str_: *const c_char,
        length: usize,
        result: *mut NapiValue,
    ) -> NapiStatus;

    fn napi_define_properties(
        env: NapiEnv,
        object: NapiValue,
        property_count: usize,
        properties: *const NapiPropertyDescriptor,
    ) -> NapiStatus;

    fn napi_throw_error(env: NapiEnv, code: *const c_char, msg: *const c_char) -> NapiStatus;

    fn napi_get_value_uint32(env: NapiEnv, value: NapiValue, result: *mut u32) -> NapiStatus;

    fn napi_get_typedarray_info(
        env: NapiEnv,
        typedarray: NapiValue,
        type_: *mut i32,
        length: *mut usize,
        data: *mut *mut c_void,
        arraybuffer: *mut NapiValue,
        byte_offset: *mut usize,
    ) -> NapiStatus;
}

fn cstring_lossy(message: impl AsRef<str>) -> CString {
    let sanitized = message.as_ref().replace('\0', "\\0");
    CString::new(sanitized).unwrap_or_else(|_| CString::new("native addon error").unwrap())
}

unsafe fn throw_error(env: NapiEnv, message: impl AsRef<str>) -> NapiValue {
    let msg = cstring_lossy(message);
    napi_throw_error(env, ptr::null(), msg.as_ptr());
    ptr::null_mut()
}

unsafe fn napi_check(env: NapiEnv, status: NapiStatus, action: &str) -> Result<(), NapiValue> {
    if status == NAPI_OK {
        Ok(())
    } else {
        Err(throw_error(
            env,
            format!("{action} failed with N-API status {status}"),
        ))
    }
}

unsafe fn get_callback_args<const N: usize>(
    env: NapiEnv,
    info: NapiCallbackInfo,
    function_name: &str,
) -> Result<[NapiValue; N], NapiValue> {
    let mut argc = N;
    let mut argv: [NapiValue; N] = [ptr::null_mut(); N];
    napi_check(
        env,
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        ),
        "read callback arguments",
    )?;
    if argc != N || argv.iter().any(|value| value.is_null()) {
        return Err(throw_error(
            env,
            format!("{function_name} expects {N} arguments"),
        ));
    }
    Ok(argv)
}

unsafe fn get_string_value(
    env: NapiEnv,
    value: NapiValue,
    label: &str,
) -> Result<String, NapiValue> {
    let mut byte_len = 0usize;
    napi_check(
        env,
        napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut byte_len),
        &format!("measure {label} string"),
    )?;

    let mut bytes = vec![0u8; byte_len + 1];
    let mut written = 0usize;
    napi_check(
        env,
        napi_get_value_string_utf8(
            env,
            value,
            bytes.as_mut_ptr() as *mut c_char,
            bytes.len(),
            &mut written,
        ),
        &format!("read {label} string"),
    )?;
    bytes.truncate(written);
    String::from_utf8(bytes).map_err(|err| throw_error(env, format!("{label} is not UTF-8: {err}")))
}

unsafe fn get_string_arg(env: NapiEnv, info: NapiCallbackInfo) -> Result<String, NapiValue> {
    let argv = get_callback_args::<1>(env, info, "runCandidateRequestJson")?;
    get_string_value(env, argv[0], "request")
}

unsafe fn get_two_string_args(
    env: NapiEnv,
    info: NapiCallbackInfo,
    function_name: &str,
) -> Result<(String, String), NapiValue> {
    let argv = get_callback_args::<2>(env, info, function_name)?;
    Ok((
        get_string_value(env, argv[0], "request")?,
        get_string_value(env, argv[1], "compact tape session id")?,
    ))
}

unsafe fn get_u32_value(env: NapiEnv, value: NapiValue, label: &str) -> Result<u32, NapiValue> {
    let mut result = 0u32;
    napi_check(
        env,
        napi_get_value_uint32(env, value, &mut result),
        &format!("read {label}"),
    )?;
    Ok(result)
}

unsafe fn get_typed_array<'a, T>(
    env: NapiEnv,
    value: NapiValue,
    expected_type: i32,
    label: &str,
) -> Result<&'a [T], NapiValue> {
    let mut actual_type = -1;
    let mut length = 0usize;
    let mut data = ptr::null_mut();
    let mut arraybuffer = ptr::null_mut();
    let mut byte_offset = 0usize;
    napi_check(
        env,
        napi_get_typedarray_info(
            env,
            value,
            &mut actual_type,
            &mut length,
            &mut data,
            &mut arraybuffer,
            &mut byte_offset,
        ),
        &format!("read {label} typed array"),
    )?;
    if actual_type != expected_type || data.is_null() {
        return Err(throw_error(
            env,
            format!("{label} has unexpected typed array type"),
        ));
    }
    Ok(std::slice::from_raw_parts(data as *const T, length))
}

unsafe fn create_js_string(env: NapiEnv, value: &str) -> Result<NapiValue, NapiValue> {
    let mut result = ptr::null_mut();
    napi_check(
        env,
        napi_create_string_utf8(
            env,
            value.as_ptr() as *const c_char,
            value.len(),
            &mut result,
        ),
        "create response string",
    )?;
    Ok(result)
}

unsafe extern "C" fn run_candidate_request_json(env: NapiEnv, info: NapiCallbackInfo) -> NapiValue {
    let request_json = match get_string_arg(env, info) {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };

    let response_json = match serde_json::from_str::<Value>(&request_json)
        .map_err(|err| format!("parse request JSON: {err}"))
        .and_then(|request| handle_request(&request).map_err(|err| err.to_string()))
        .and_then(|response| {
            serde_json::to_string(&response)
                .map_err(|err| format!("serialize response JSON: {err}"))
        }) {
        Ok(value) => value,
        Err(message) => return throw_error(env, message),
    };

    match create_js_string(env, &response_json) {
        Ok(value) => value,
        Err(thrown) => thrown,
    }
}

unsafe extern "C" fn run_candidate_summary_compact_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let argv = match get_callback_args::<9>(env, info, "runCandidateSummaryCompactJson") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let request_json = match get_string_value(env, argv[0], "request") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let metadata_json = match get_string_value(env, argv[1], "compact tape metadata") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let trial_index = match get_typed_array::<i32>(env, argv[2], NAPI_INT32_ARRAY, "trialIndex") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let trial_seed = match get_typed_array::<f64>(env, argv[3], NAPI_FLOAT64_ARRAY, "trialSeed") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let ltc_event_occurs =
        match get_typed_array::<u8>(env, argv[4], NAPI_UINT8_ARRAY, "ltcEventOccurs") {
            Ok(value) => value,
            Err(thrown) => return thrown,
        };
    let cashflow_present =
        match get_typed_array::<u8>(env, argv[5], NAPI_UINT8_ARRAY, "cashflowPresent") {
            Ok(value) => value,
            Err(thrown) => return thrown,
        };
    let market_state = match get_typed_array::<u8>(env, argv[6], NAPI_UINT8_ARRAY, "marketState") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let market_years = match get_typed_array::<f64>(env, argv[7], NAPI_FLOAT64_ARRAY, "marketYears")
    {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let year_field_count = match get_u32_value(env, argv[8], "yearFieldCount") {
        Ok(value) => value as usize,
        Err(thrown) => return thrown,
    };

    let response_json = match serde_json::from_str::<Value>(&request_json)
        .map_err(|err| format!("parse request JSON: {err}"))
        .and_then(|request| {
            let metadata = serde_json::from_str::<Value>(&metadata_json)
                .map_err(|err| format!("parse compact tape metadata JSON: {err}"))?;
            if year_field_count != COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT {
                return Err(format!(
                    "unsupported compact tape year field count: {year_field_count}"
                ));
            }
            handle_request_with_compact_summary_tape(
                &request,
                CompactSummaryTapeInput {
                    metadata,
                    trial_index,
                    trial_seed,
                    ltc_event_occurs,
                    cashflow_present,
                    market_state,
                    market_years,
                    year_field_count,
                },
            )
            .map_err(|err| err.to_string())
        })
        .and_then(|response| {
            serde_json::to_string(&response)
                .map_err(|err| format!("serialize response JSON: {err}"))
        }) {
        Ok(value) => value,
        Err(message) => return throw_error(env, message),
    };

    match create_js_string(env, &response_json) {
        Ok(value) => value,
        Err(thrown) => thrown,
    }
}

unsafe extern "C" fn register_candidate_summary_compact_tape_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let argv = match get_callback_args::<9>(env, info, "registerCandidateSummaryCompactTapeJson") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let session_id = match get_string_value(env, argv[0], "compact tape session id") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let metadata_json = match get_string_value(env, argv[1], "compact tape metadata") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let trial_index = match get_typed_array::<i32>(env, argv[2], NAPI_INT32_ARRAY, "trialIndex") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let trial_seed = match get_typed_array::<f64>(env, argv[3], NAPI_FLOAT64_ARRAY, "trialSeed") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let ltc_event_occurs =
        match get_typed_array::<u8>(env, argv[4], NAPI_UINT8_ARRAY, "ltcEventOccurs") {
            Ok(value) => value,
            Err(thrown) => return thrown,
        };
    let cashflow_present =
        match get_typed_array::<u8>(env, argv[5], NAPI_UINT8_ARRAY, "cashflowPresent") {
            Ok(value) => value,
            Err(thrown) => return thrown,
        };
    let market_state = match get_typed_array::<u8>(env, argv[6], NAPI_UINT8_ARRAY, "marketState") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let market_years = match get_typed_array::<f64>(env, argv[7], NAPI_FLOAT64_ARRAY, "marketYears")
    {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let year_field_count = match get_u32_value(env, argv[8], "yearFieldCount") {
        Ok(value) => value as usize,
        Err(thrown) => return thrown,
    };
    if year_field_count != COMPACT_SUMMARY_TAPE_YEAR_FIELD_COUNT {
        return throw_error(
            env,
            format!("unsupported compact tape year field count: {year_field_count}"),
        );
    }

    let metadata = match serde_json::from_str::<Value>(&metadata_json)
        .map_err(|err| format!("parse compact tape metadata JSON: {err}"))
    {
        Ok(value) => value,
        Err(message) => return throw_error(env, message),
    };
    let owned = OwnedCompactSummaryTape {
        metadata,
        trial_index: trial_index.to_vec(),
        trial_seed: trial_seed.to_vec(),
        ltc_event_occurs: ltc_event_occurs.to_vec(),
        cashflow_present: cashflow_present.to_vec(),
        market_state: market_state.to_vec(),
        market_years: market_years.to_vec(),
        year_field_count,
    };
    if let Err(message) = owned.as_input().dimensions() {
        return throw_error(env, message);
    }
    match compact_tape_sessions().lock() {
        Ok(mut sessions) => {
            sessions.insert(session_id.clone(), owned);
        }
        Err(_) => return throw_error(env, "compact tape session cache lock poisoned"),
    }
    match create_js_string(env, &session_id) {
        Ok(value) => value,
        Err(thrown) => thrown,
    }
}

unsafe extern "C" fn run_candidate_summary_compact_session_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let (request_json, session_id) =
        match get_two_string_args(env, info, "runCandidateSummaryCompactSessionJson") {
            Ok(value) => value,
            Err(thrown) => return thrown,
        };
    let response_json = match serde_json::from_str::<Value>(&request_json)
        .map_err(|err| format!("parse request JSON: {err}"))
        .and_then(|request| {
            let sessions = compact_tape_sessions()
                .lock()
                .map_err(|_| "compact tape session cache lock poisoned".to_string())?;
            let tape = sessions
                .get(&session_id)
                .ok_or_else(|| format!("unknown compact tape session id: {session_id}"))?;
            handle_request_with_compact_summary_tape(&request, tape.as_input())
                .map_err(|err| err.to_string())
        })
        .and_then(|response| {
            serde_json::to_string(&response)
                .map_err(|err| format!("serialize response JSON: {err}"))
        }) {
        Ok(value) => value,
        Err(message) => return throw_error(env, message),
    };
    match create_js_string(env, &response_json) {
        Ok(value) => value,
        Err(thrown) => thrown,
    }
}

unsafe extern "C" fn clear_candidate_summary_compact_tape_json(
    env: NapiEnv,
    info: NapiCallbackInfo,
) -> NapiValue {
    let argv = match get_callback_args::<1>(env, info, "clearCandidateSummaryCompactTapeJson") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    let session_id = match get_string_value(env, argv[0], "compact tape session id") {
        Ok(value) => value,
        Err(thrown) => return thrown,
    };
    match compact_tape_sessions().lock() {
        Ok(mut sessions) => {
            sessions.remove(&session_id);
        }
        Err(_) => return throw_error(env, "compact tape session cache lock poisoned"),
    }
    match create_js_string(env, "ok") {
        Ok(value) => value,
        Err(thrown) => thrown,
    }
}

#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    let request_property_name = cstring_lossy("runCandidateRequestJson");
    let compact_property_name = cstring_lossy("runCandidateSummaryCompactJson");
    let register_compact_property_name = cstring_lossy("registerCandidateSummaryCompactTapeJson");
    let session_compact_property_name = cstring_lossy("runCandidateSummaryCompactSessionJson");
    let clear_compact_property_name = cstring_lossy("clearCandidateSummaryCompactTapeJson");
    let properties = [
        NapiPropertyDescriptor {
            utf8name: request_property_name.as_ptr(),
            name: ptr::null_mut(),
            method: Some(run_candidate_request_json),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: 0,
            data: ptr::null_mut(),
        },
        NapiPropertyDescriptor {
            utf8name: compact_property_name.as_ptr(),
            name: ptr::null_mut(),
            method: Some(run_candidate_summary_compact_json),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: 0,
            data: ptr::null_mut(),
        },
        NapiPropertyDescriptor {
            utf8name: register_compact_property_name.as_ptr(),
            name: ptr::null_mut(),
            method: Some(register_candidate_summary_compact_tape_json),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: 0,
            data: ptr::null_mut(),
        },
        NapiPropertyDescriptor {
            utf8name: session_compact_property_name.as_ptr(),
            name: ptr::null_mut(),
            method: Some(run_candidate_summary_compact_session_json),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: 0,
            data: ptr::null_mut(),
        },
        NapiPropertyDescriptor {
            utf8name: clear_compact_property_name.as_ptr(),
            name: ptr::null_mut(),
            method: Some(clear_candidate_summary_compact_tape_json),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: 0,
            data: ptr::null_mut(),
        },
    ];

    if napi_define_properties(env, exports, properties.len(), properties.as_ptr()) != NAPI_OK {
        return throw_error(env, "define native addon exports failed");
    }
    exports
}
