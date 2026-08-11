use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const PROTOCOL_SNAPSHOT: &str = "codex-app-server-v2:initialize,initialized,account/read,account/rateLimits/read,model/list,thread/start,thread/resume,thread/read,turn/start,turn/interrupt;thread.id,turn.id,turn.status,item.agentMessage.text";

#[derive(Clone, Debug, Serialize)]
pub struct JsonRpcRequest<'a> {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: &'a str,
    pub params: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct JsonRpcNotification<'a> {
    pub jsonrpc: &'static str,
    pub method: &'a str,
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JsonRpcMessage {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(default)]
    pub params: Option<Value>,
}

pub fn extract_agent_message(turn: &Value) -> Option<&str> {
    turn.get("items")?
        .as_array()?
        .iter()
        .rev()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage"))?
        .get("text")?
        .as_str()
}

pub fn contains_tool_item(turn: &Value) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                !matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("userMessage" | "agentMessage" | "reasoning" | "plan")
                )
            })
        })
}
