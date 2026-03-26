"""
Vault Client - Async HTTP Client for Vault Service

Communicates with the Vault Service at http://localhost:5000
All methods use POST requests with JSON bodies (internal API design)

Error handling:
  - 404 from Vault -> {"success": False, "status": 404, "error": "..."}
  - Network error  -> {"success": False, "status": 503, "error": "Vault service unavailable"}
  - 500 from Vault -> {"success": False, "status": 502, "error": "Vault internal error"}

No automatic retries. 5-second timeout on all requests.
Does NOT log credential fields (username, password, etc.)
"""

import os
import httpx

VAULT_URL = os.environ.get("VAULT_URL", "http://localhost:5000")
TIMEOUT_S = 5.0


async def _vault_request(endpoint: str, body: dict) -> dict:
    """Make a request to Vault Service with timeout."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.post(
                f"{VAULT_URL}{endpoint}",
                json=body,
            )

        data = response.json()

        if response.is_success:
            return {"success": True, "status": response.status_code, "data": data}

        # Handle Vault errors
        if response.status_code == 404:
            return {"success": False, "status": 404, "error": data.get("error", "Not found")}

        if response.status_code >= 500:
            print(f"[VAULT CLIENT] Vault error {response.status_code}: {data.get('error')}")
            return {"success": False, "status": 502, "error": "Vault internal error"}

        # Other errors (400, etc.)
        return {"success": False, "status": response.status_code, "error": data.get("error", "Vault request failed")}

    except httpx.TimeoutException:
        print("[VAULT CLIENT] Request timeout")
        return {"success": False, "status": 503, "error": "Vault service timeout"}
    except Exception as err:
        print(f"[VAULT CLIENT] Network error: {err}")
        return {"success": False, "status": 503, "error": "Vault service unavailable"}


async def read(vault_id: str, app_id: str) -> dict:
    """Read credentials from Vault."""
    print(f"[VAULT CLIENT] read(vaultId={vault_id}, appId={app_id})")
    result = await _vault_request("/internal/vault/read", {"vaultId": vault_id, "appId": app_id})

    if result["success"]:
        return {"success": True, "status": result["status"], "fields": result["data"]["fields"]}

    return result


async def write(vault_id: str, app_id: str, fields: dict) -> dict:
    """Write credentials to Vault."""
    print(f"[VAULT CLIENT] write(vaultId={vault_id}, appId={app_id}) [fields not logged]")
    return await _vault_request("/internal/vault/write", {"vaultId": vault_id, "appId": app_id, "fields": fields})


async def update_password(vault_id: str, app_id: str, new_password: str) -> dict:
    """Update password only (merges into existing fields)."""
    print(f"[VAULT CLIENT] updatePassword(vaultId={vault_id}, appId={app_id}) [password not logged]")
    return await _vault_request("/internal/vault/update-password", {"vaultId": vault_id, "appId": app_id, "newPassword": new_password})


async def delete_credential(vault_id: str, app_id: str) -> dict:
    """Delete single credential."""
    print(f"[VAULT CLIENT] delete(vaultId={vault_id}, appId={app_id})")
    return await _vault_request("/internal/vault/delete", {"vaultId": vault_id, "appId": app_id})


async def delete_vault(vault_id: str) -> dict:
    """Delete all credentials for a vault (cascade on user deletion)."""
    print(f"[VAULT CLIENT] deleteVault(vaultId={vault_id})")
    return await _vault_request("/internal/vault/delete-vault", {"vaultId": vault_id})


async def health_check() -> bool:
    """Health check."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.get(f"{VAULT_URL}/health")
            return response.is_success
    except Exception:
        return False
