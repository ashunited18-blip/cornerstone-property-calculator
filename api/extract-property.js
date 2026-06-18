import { createVerify } from 'crypto';

const PROJECT_ID = 'cornerstone-calculator';
const ADMIN_EMAILS = ['ashunited18@gmail.com', 'adityasunil2010@gmail.com'];

// Verifies a Firebase ID token using Google's public keys (no firebase-admin needed).
async function verifyFirebaseIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header  = JSON.parse(Buffer.from(headerB64,  'base64url').toString());
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now)          throw new Error('Token expired');
  if (payload.iat > now + 300)    throw new Error('Token from future');
  if (payload.aud !== PROJECT_ID) throw new Error('Wrong audience');
  if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('Wrong issuer');
  if (!payload.sub)               throw new Error('Missing subject');

  const certsRes = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  const certs = await certsRes.json();
  const cert = certs[header.kid];
  if (!cert) throw new Error('Unknown signing key');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(cert, Buffer.from(signatureB64, 'base64url')))
    throw new Error('Invalid signature');

  return payload;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verify Firebase ID token from Authorization header
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = await verifyFirebaseIdToken(idToken);
    const email = (payload.email || '').toLowerCase();
    if (!ADMIN_EMAILS.map(e => e.toLowerCase()).includes(email)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'No document text provided' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is not configured with an API key' });
    return;
  }

  const trimmedText = text.slice(0, 20000);

  const schemaDescription = `
Extract whatever of the following fields you can confidently find in the document.
Use null for any field you cannot find - never guess or invent a value.

- address: string (street + house number, e.g. "Dinglerstrasse 6")
- city: string (e.g. "Augsburg")
- buildYear: string (construction year, e.g. "1934")
- mode: "altbau" or "neubau" (Altbau = older/existing building, Neubau = new construction). Infer from buildYear or explicit wording if not stated directly.
- price: number (purchase price / Kaufpreis, in EUR, no currency symbol or separators)
- rent: number (monthly cold rent / Kaltmiete, in EUR/month)
- area: number (living area / Wohnfläche, in m²)
- build: number (building portion of the purchase price as a percentage, 0-100, e.g. land value vs. building value split - often NOT stated explicitly; use null if not found)
`.trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{
          name: 'extract_property_data',
          description: 'Records extracted property listing fields',
          input_schema: {
            type: 'object',
            properties: {
              address:   { type: ['string', 'null'] },
              city:      { type: ['string', 'null'] },
              buildYear: { type: ['string', 'null'] },
              mode:      { type: ['string', 'null'], enum: ['altbau', 'neubau', null] },
              price:     { type: ['number', 'null'] },
              rent:      { type: ['number', 'null'] },
              area:      { type: ['number', 'null'] },
              build:     { type: ['number', 'null'] }
            },
            required: ['address', 'city', 'buildYear', 'mode', 'price', 'rent', 'area', 'build']
          }
        }],
        tool_choice: { type: 'tool', name: 'extract_property_data' },
        messages: [{
          role: 'user',
          content: `${schemaDescription}\n\nDocument text:\n"""\n${trimmedText}\n"""`
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      res.status(502).json({ error: 'Extraction service error' });
      return;
    }

    const data = await response.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) {
      res.status(502).json({ error: 'No structured data returned' });
      return;
    }

    res.status(200).json({ fields: toolUse.input });
  } catch (e) {
    console.error('Extraction failed:', e);
    res.status(500).json({ error: 'Extraction failed' });
  }
}
