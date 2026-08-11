use async_trait::async_trait;
use campaign_domain::Hash256;
use serde_json::Value;

use crate::{
    RoleError, RoleRequest, RoleResult, RoleSpec, ValidatedRoleResult, contracts,
    semantic::validate_semantics,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoleRunState {
    Prepared,
    Running,
    AwaitingTool,
    Validating,
    Completed,
    Failed,
    Unreconciled,
}

#[derive(Clone, Debug)]
pub struct RoleTransportExchange {
    pub response: Value,
    pub response_hash: Hash256,
    pub provider_identity_hash: Hash256,
    pub repaired: bool,
    pub transport: String,
    pub fallback_reason: Option<String>,
    pub remote_run_hash: Option<Hash256>,
    pub usage: Value,
}

#[async_trait]
pub trait RoleTransport: Send + Sync {
    async fn exchange(
        &self,
        spec: &RoleSpec,
        request: &RoleRequest,
    ) -> Result<RoleTransportExchange, RoleError>;
}

#[async_trait]
impl<T: RoleTransport + ?Sized> RoleTransport for Box<T> {
    async fn exchange(
        &self,
        spec: &RoleSpec,
        request: &RoleRequest,
    ) -> Result<RoleTransportExchange, RoleError> {
        (**self).exchange(spec, request).await
    }
}
pub struct AnnotatedRoleTransport {
    inner: Box<dyn RoleTransport>,
    fallback_reason: String,
}

impl AnnotatedRoleTransport {
    pub fn new(inner: Box<dyn RoleTransport>, fallback_reason: impl Into<String>) -> Self {
        Self {
            inner,
            fallback_reason: fallback_reason.into(),
        }
    }
}

#[async_trait]
impl RoleTransport for AnnotatedRoleTransport {
    async fn exchange(
        &self,
        spec: &RoleSpec,
        request: &RoleRequest,
    ) -> Result<RoleTransportExchange, RoleError> {
        let mut exchange = self.inner.exchange(spec, request).await?;
        exchange.fallback_reason = Some(self.fallback_reason.clone());
        Ok(exchange)
    }
}

pub struct FallbackRoleTransport {
    primary: Box<dyn RoleTransport>,
    fallback: Box<dyn RoleTransport>,
    fallback_reason: String,
}

impl FallbackRoleTransport {
    pub fn new(
        primary: Box<dyn RoleTransport>,
        fallback: Box<dyn RoleTransport>,
        fallback_reason: impl Into<String>,
    ) -> Self {
        Self {
            primary,
            fallback,
            fallback_reason: fallback_reason.into(),
        }
    }
}

#[async_trait]
impl RoleTransport for FallbackRoleTransport {
    async fn exchange(
        &self,
        spec: &RoleSpec,
        request: &RoleRequest,
    ) -> Result<RoleTransportExchange, RoleError> {
        match self.primary.exchange(spec, request).await {
            Ok(exchange) => Ok(exchange),
            Err(RoleError::Transport) => {
                let mut exchange = self.fallback.exchange(spec, request).await?;
                exchange.fallback_reason = Some(self.fallback_reason.clone());
                Ok(exchange)
            }
            Err(error) => Err(error),
        }
    }
}
#[async_trait]
pub trait RoleExecutor: Send + Sync {
    async fn execute(
        &self,
        spec: &RoleSpec,
        request: RoleRequest,
    ) -> Result<ValidatedRoleResult, RoleError>;
}

pub struct TypedRoleExecutor<T> {
    transport: T,
}

impl<T> TypedRoleExecutor<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }
}

#[async_trait]
impl<T: RoleTransport> RoleExecutor for TypedRoleExecutor<T> {
    async fn execute(
        &self,
        spec: &RoleSpec,
        request: RoleRequest,
    ) -> Result<ValidatedRoleResult, RoleError> {
        if spec.role != request.role {
            return Err(RoleError::ProvenanceMismatch);
        }
        let exchange = self.transport.exchange(spec, &request).await?;
        if exchange.repaired {
            return Err(RoleError::RepairedOutput);
        }
        contracts::validate_role_result(&exchange.response)?;
        let result: RoleResult =
            serde_json::from_value(exchange.response).map_err(|_| RoleError::SchemaInvalid)?;
        validate_semantics(&request, &result)?;
        Ok(ValidatedRoleResult {
            result,
            response_hash: exchange.response_hash,
            provider_identity_hash: exchange.provider_identity_hash,
            repaired: false,
            transport: exchange.transport,
            fallback_reason: exchange.fallback_reason,
            remote_run_hash: exchange.remote_run_hash,
            usage: exchange.usage,
        })
    }
}
