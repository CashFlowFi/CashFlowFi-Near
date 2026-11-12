//! NEP-297 style event logs (`EVENT_JSON:`), read by the watcher and the frontend.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub(crate) fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "cashflow", "version": "1.0.0", "event": event, "data": [data]})
    ));
}
