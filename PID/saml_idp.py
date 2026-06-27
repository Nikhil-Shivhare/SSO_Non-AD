"""
PID SAML Identity Provider Module

Handles:
- Loading dev signing certificate and private key
- Decoding HTTP-Redirect binding SAMLRequest (base64 + raw DEFLATE)
- Building a signed SAMLResponse XML using lxml + signxml
- Rendering the auto-post HTML form that delivers SAMLResponse to the SP ACS URL

Security notes (PoC only):
- Uses self-signed dev certificate (dev-idp.key / dev-idp.crt)
- In production: use a properly managed PKI certificate
- Assertion TTL is short (5 minutes) with 2-minute clock skew tolerance
"""

import base64
import os
import secrets
import time
import zlib
from datetime import datetime, timezone, timedelta

from lxml import etree
from signxml import XMLSigner, methods

# ---------------------------------------------------------------------------
# PATHS
# ---------------------------------------------------------------------------

CERTS_DIR = os.path.join(os.path.dirname(__file__), "certs")
KEY_PATH  = os.getenv("SAML_IDP_KEY_PATH",  os.path.join(CERTS_DIR, "dev-idp.key"))
CERT_PATH = os.getenv("SAML_IDP_CERT_PATH", os.path.join(CERTS_DIR, "dev-idp.crt"))

# ---------------------------------------------------------------------------
# SAML NAMESPACES
# ---------------------------------------------------------------------------

NS = {
    "samlp": "urn:oasis:names:tc:SAML:2.0:protocol",
    "saml":  "urn:oasis:names:tc:SAML:2.0:assertion",
    "ds":    "http://www.w3.org/2000/09/xmldsig#",
}

# Register namespaces so lxml uses canonical prefixes
for prefix, uri in NS.items():
    etree.register_namespace(prefix, uri)

# ---------------------------------------------------------------------------
# CERT / KEY LOADING
# ---------------------------------------------------------------------------

def load_cert_pem() -> str:
    """Return PEM certificate as a string (used for metadata embedding)."""
    with open(CERT_PATH, "r") as f:
        return f.read().strip()


def load_cert_body() -> str:
    """Return base64 body of PEM cert without header/footer (for XML embedding)."""
    pem = load_cert_pem()
    lines = [l for l in pem.splitlines() if not l.startswith("-----")]
    return "".join(lines)


def load_key_pem() -> str:
    """Return private key PEM as a string."""
    with open(KEY_PATH, "r") as f:
        return f.read().strip()


# ---------------------------------------------------------------------------
# REDIRECT-BINDING DECODE
# ---------------------------------------------------------------------------

def decode_redirect_saml_request(raw_saml_request: str) -> bytes:
    """
    Decode a SAMLRequest sent via HTTP-Redirect binding.

    Steps:
      1. URL-decode is already handled by the web framework query parser.
      2. base64-decode the value.
      3. raw-DEFLATE decompress (no zlib header: negative wbits).

    Raises ValueError on decode or decompression failure.
    """
    try:
        compressed = base64.b64decode(raw_saml_request)
    except Exception as exc:
        raise ValueError(f"base64 decode failed: {exc}") from exc

    try:
        return zlib.decompress(compressed, -zlib.MAX_WBITS)
    except Exception as exc:
        raise ValueError(f"DEFLATE decompress failed: {exc}") from exc


def parse_authn_request(xml_bytes: bytes) -> dict:
    """
    Parse a decoded AuthnRequest XML and return relevant fields.

    Returns:
        {
            "request_id": str,
            "issuer": str,
            "acs_url": str,      # may be None if not in request
            "relay_state": str,  # passed separately, not extracted here
        }
    """
    try:
        root = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"XML parse failed: {exc}") from exc

    request_id = root.get("ID", "")
    acs_url    = root.get("AssertionConsumerServiceURL", "")

    issuer_el  = root.find(f"{{{NS['saml']}}}Issuer")
    issuer     = issuer_el.text.strip() if issuer_el is not None else ""

    return {
        "request_id": request_id,
        "issuer":     issuer,
        "acs_url":    acs_url,
    }


# ---------------------------------------------------------------------------
# SAML RESPONSE / ASSERTION BUILDER
# ---------------------------------------------------------------------------

def _ts(dt: datetime) -> str:
    """Format a datetime as SAML timestamp (UTC, no microseconds)."""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def build_saml_response(
    *,
    sp_entity_id: str,
    sp_acs_url:   str,
    name_id:      str,
    request_id:   str,
    role:         str  = "user",
    email:        str  = None,
    idp_entity_id: str = None,
    assertion_ttl_seconds: int = 300,
    clock_skew_seconds:    int = 120,
) -> bytes:
    """
    Build a SAML 2.0 Response with a signed Assertion.

    The Assertion is signed using the dev IdP private key.
    The Response element itself is unsigned (assertion-only signing is
    standard and sufficient for the MVP).

    Returns:
        Signed SAMLResponse XML as bytes.
    """
    if idp_entity_id is None:
        idp_entity_id = os.getenv(
            "SAML_IDP_ENTITY_ID", "http://localhost:4000/saml/metadata"
        )
    if email is None:
        email = f"{name_id}@example.local"

    now          = datetime.now(timezone.utc)
    not_before   = now - timedelta(seconds=clock_skew_seconds)
    not_on_after = now + timedelta(seconds=assertion_ttl_seconds)

    response_id  = "_resp_" + secrets.token_hex(16)
    assertion_id = "_asrt_" + secrets.token_hex(16)
    session_idx  = "_sess_" + secrets.token_hex(16)

    # -----------------------------------------------------------------------
    # 1. Build the Response envelope (unsigned)
    # -----------------------------------------------------------------------
    SAMLP = NS["samlp"]
    SAML  = NS["saml"]

    # lxml requires namespace declarations via nsmap, NOT xmlns: attributes
    nsmap = {
        "samlp": SAMLP,
        "saml":  SAML,
        "ds":    NS["ds"],
    }

    response = etree.Element(
        f"{{{SAMLP}}}Response",
        nsmap=nsmap,
        attrib={
            "ID":           response_id,
            "Version":      "2.0",
            "IssueInstant": _ts(now),
            "Destination":  sp_acs_url,
            "InResponseTo": request_id,
        },
    )

    # Issuer
    issuer_el = etree.SubElement(response, f"{{{SAML}}}Issuer")
    issuer_el.text = idp_entity_id

    # Status → StatusCode
    status = etree.SubElement(response, f"{{{SAMLP}}}Status")
    status_code = etree.SubElement(
        status,
        f"{{{SAMLP}}}StatusCode",
        attrib={"Value": "urn:oasis:names:tc:SAML:2.0:status:Success"},
    )

    # -----------------------------------------------------------------------
    # 2. Build the Assertion (will be signed)
    # -----------------------------------------------------------------------
    assertion = etree.SubElement(
        response,
        f"{{{SAML}}}Assertion",
        attrib={
            "ID":          assertion_id,
            "Version":     "2.0",
            "IssueInstant": _ts(now),
        },
    )

    # Issuer inside Assertion
    a_issuer = etree.SubElement(assertion, f"{{{SAML}}}Issuer")
    a_issuer.text = idp_entity_id

    # Subject
    subject = etree.SubElement(assertion, f"{{{SAML}}}Subject")
    name_id_el = etree.SubElement(
        subject,
        f"{{{SAML}}}NameID",
        attrib={
            "Format": "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
        },
    )
    name_id_el.text = name_id

    subject_conf = etree.SubElement(
        subject,
        f"{{{SAML}}}SubjectConfirmation",
        attrib={"Method": "urn:oasis:names:tc:SAML:2.0:cm:bearer"},
    )
    etree.SubElement(
        subject_conf,
        f"{{{SAML}}}SubjectConfirmationData",
        attrib={
            "NotOnOrAfter": _ts(not_on_after),
            "Recipient":    sp_acs_url,
            "InResponseTo": request_id,
        },
    )

    # Conditions
    conditions = etree.SubElement(
        assertion,
        f"{{{SAML}}}Conditions",
        attrib={
            "NotBefore":    _ts(not_before),
            "NotOnOrAfter": _ts(not_on_after),
        },
    )
    audience_restriction = etree.SubElement(
        conditions, f"{{{SAML}}}AudienceRestriction"
    )
    audience = etree.SubElement(audience_restriction, f"{{{SAML}}}Audience")
    audience.text = sp_entity_id

    # AuthnStatement
    authn_stmt = etree.SubElement(
        assertion,
        f"{{{SAML}}}AuthnStatement",
        attrib={
            "AuthnInstant": _ts(now),
            "SessionIndex": session_idx,
        },
    )
    authn_ctx = etree.SubElement(authn_stmt, f"{{{SAML}}}AuthnContext")
    authn_ctx_class = etree.SubElement(
        authn_ctx, f"{{{SAML}}}AuthnContextClassRef"
    )
    authn_ctx_class.text = (
        "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
    )

    # AttributeStatement
    attr_stmt = etree.SubElement(assertion, f"{{{SAML}}}AttributeStatement")

    def _add_attr(name: str, value: str):
        attr = etree.SubElement(
            attr_stmt,
            f"{{{SAML}}}Attribute",
            attrib={
                "Name":             name,
                "NameFormat":       "urn:oasis:names:tc:SAML:2.0:attrname-format:basic",
                "FriendlyName":     name,
            },
        )
        av = etree.SubElement(attr, f"{{{SAML}}}AttributeValue")
        av.text = value

    _add_attr("username", name_id)
    _add_attr("role",     role)
    _add_attr("email",    email)

    # -----------------------------------------------------------------------
    # 3. Sign the Assertion element directly (Signature placed INSIDE Assertion)
    #
    # node-saml's getVerifiedXml enforces:
    #   signature.parentNode === the element referenced by URI
    # Therefore <ds:Signature> must be a direct child of <saml:Assertion>,
    # and the reference URI must be "#assertion_id".
    #
    # Procedure:
    #   a) Detach assertion from response (it's still in memory)
    #   b) Sign the assertion standalone — signxml inserts Signature inside it
    #   c) Re-attach the signed assertion into the response
    # -----------------------------------------------------------------------
    key_pem  = load_key_pem()
    cert_pem = load_cert_pem()

    signer = XMLSigner(
        method=methods.enveloped,
        signature_algorithm="rsa-sha256",
        digest_algorithm="sha256",
        c14n_algorithm="http://www.w3.org/2001/10/xml-exc-c14n#",
    )

    # Remove assertion from response so signxml sees it as the root
    response.remove(assertion)

    # Sign the assertion (standalone root); signxml inserts <ds:Signature>
    # as first child after <saml:Issuer> per the enveloped signature method
    signed_assertion = signer.sign(
        assertion,
        key=key_pem,
        cert=cert_pem,
        reference_uri=f"#{assertion_id}",
    )

    # Re-insert signed assertion into the response at the correct position
    # (after Status, i.e. as 3rd child: Issuer, Status, Assertion)
    response.append(signed_assertion)

    return etree.tostring(response, xml_declaration=True, encoding="UTF-8")


# ---------------------------------------------------------------------------
# AUTO-POST FORM
# ---------------------------------------------------------------------------

def render_auto_post_form(acs_url: str, saml_response_b64: str, relay_state: str = "") -> str:
    """
    Return an HTML page with a self-submitting form that POSTs the
    SAMLResponse to the SP ACS URL (HTTP-POST binding).
    """
    relay_input = ""
    if relay_state:
        import html as _html
        relay_input = (
            f'<input type="hidden" name="RelayState" '
            f'value="{_html.escape(relay_state)}">'
        )

    return f"""<!DOCTYPE html>
<html>
<head><title>SSO Redirect</title></head>
<body onload="document.forms[0].submit()">
  <noscript>
    <p>JavaScript is required to complete SSO. Click the button below:</p>
    <button type="submit" form="saml-form">Continue to Application</button>
  </noscript>
  <form id="saml-form" method="POST" action="{acs_url}">
    <input type="hidden" name="SAMLResponse" value="{saml_response_b64}">
    {relay_input}
  </form>
</body>
</html>"""


# ---------------------------------------------------------------------------
# IDP METADATA
# ---------------------------------------------------------------------------

def build_idp_metadata_xml(
    idp_entity_id: str,
    sso_url:       str,
    cert_body:     str,
) -> str:
    """Return PID IdP metadata XML as a string."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
    xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
    xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
    entityID="{idp_entity_id}">
  <md:IDPSSODescriptor
      WantAuthnRequestsSigned="false"
      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>{cert_body}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="{sso_url}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>"""
