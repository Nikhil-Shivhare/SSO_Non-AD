1️⃣ When should fingerprint be required?
Every replay?
Once per browser session?
Once per app per session?

2️⃣ Should learning (first-time save) require fingerprint too?
Yes / No

3️⃣ Should fingerprint failure:
Block replay completely?
Allow manual login fallback?

4️⃣ OS for ==   windows only 

Fingerprint frequency      → Once per app per browser session
Fingerprint on learning    → NO
On fingerprint failure     → Allow manual login fallback
Demo OS                    → Windows-only


Detect app
→ Fetch credentials
→ Check: fingerprint already verified for this app?
    → NO → Trigger fingerprint prompt
         → Success → mark verified
         → Failure → allow manual login (no replay)
    → YES → skip prompt
→ Autofill & submit


Session reset (browser restart) → fingerprint required again

Before replaying credentials, the extension requires local biometric verification using the platform authenticator. This ensures credentials are released only with explicit user presence, while still allowing manual login if biometric verification is skipped.