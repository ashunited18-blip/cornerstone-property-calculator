// Vercel serverless function — proxies a Claude API call so the API key
// never has to live in browser JS. Receives raw text extracted client-side
// from an uploaded PDF/Word document, asks Claude to pull out whatever
// property fields it can find, and returns structured JSON.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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

  // Cap input size to keep cost/latency predictable
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
              address: { type: ['string', 'null'] },
              city: { type: ['string', 'null'] },
              buildYear: { type: ['string', 'null'] },
              mode: { type: ['string', 'null'], enum: ['altbau', 'neubau', null] },
              price: { type: ['number', 'null'] },
              rent: { type: ['number', 'null'] },
              area: { type: ['number', 'null'] },
              build: { type: ['number', 'null'] }
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
