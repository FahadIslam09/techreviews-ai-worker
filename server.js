import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import Post from './models/Post.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// ── Database Connection ──
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ── Helpers ──
function cleanTranscript(raw) {
  const fillerPatterns = [
    /please (like|subscribe|share|comment|hit the bell).{0,80}/gi,
    /smash the (like|subscribe).{0,60}/gi,
    /don't forget to (like|subscribe|share).{0,80}/gi,
    /turn on (post )?notifications?.{0,60}/gi,
    /this video is (sponsored|brought to you).{0,200}/gi,
    /use (my )?code .{0,100} for .{0,60}% off.{0,100}/gi,
    /check out (the )?(link|links?) in (the )?description.{0,80}/gi,
    /(welcome (back )?to (my |the )?channel|thanks? for watching).{0,100}/gi,
    /\[music\]|\[applause\]|\[laughter\]/gi,
    /\s{2,}/g,
  ];
  let cleaned = raw;
  fillerPatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, pattern.source === '\\s{2,}' ? ' ' : '');
  });
  return cleaned.trim();
}

function slugify(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

// ── 🚀 Official DeepSeek API Function ──
async function callDeepSeek(prompt, isJson = false, modelName = "deepseek-v4-flash") {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      temperature: isJson ? 0.1 : 0.65,
      response_format: isJson ? { type: "json_object" } : { type: "text" }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "DeepSeek API failed.");
  return data.choices[0].message.content;
}

// ── 🚀 MAIN API ROUTE ──
app.post('/api/generate-post', async (req, res) => {
  // ১. Security Check (Vercel থেকে সিক্রেট কি না পাঠালে ব্লক করে দেবে)
  if (req.headers['x-api-key'] !== process.env.MICROSERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Access' });
  }

  // ২. 🚀 HEARTBEAT MECHANISM (Render Timeout বাইপাস করার জন্য)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  // প্রতি ১৫ সেকেন্ডে একটি 'Space' পাঠাবে যাতে সার্ভার বুঝতে পারে কাজ চলছে
  const keepAlive = setInterval(() => { res.write(' '); }, 15000);

  try {
    const { videoUrl, videoId, originalCreator, thumbnail, targetName, referenceUrl, rawSpecs, manualPrice } = req.body;
    if (!videoUrl) throw new Error('YouTube video URL is required.');

    let derivedVideoId = videoId;
    if (!derivedVideoId && videoUrl) {
      try {
        const urlObj = new URL(videoUrl);
        derivedVideoId = urlObj.hostname === 'youtu.be' ? urlObj.pathname.slice(1) : urlObj.searchParams.get('v');
      } catch (e) { }
    }

    // ৩. RapidAPI Fetch
    const apiKeys = [process.env.RAPID_API_KEY_1, process.env.RAPID_API_KEY_2, process.env.RAPID_API_KEY_3, process.env.RAPID_API_KEY_4].filter(Boolean);
    let rawTranscript = "";
    let transcriptFetched = false;

    for (let i = 0; i < apiKeys.length; i++) {
      try {
        const rapidApiRes = await fetch(`https://youtube-transcript3.p.rapidapi.com/api/transcript?videoId=${derivedVideoId}`, {
          headers: { 'x-rapidapi-host': 'youtube-transcript3.p.rapidapi.com', 'x-rapidapi-key': apiKeys[i] }
        });
        if (rapidApiRes.ok) {
          const transcriptData = await rapidApiRes.json();
          if (transcriptData && transcriptData.transcript && Array.isArray(transcriptData.transcript)) {
            rawTranscript = transcriptData.transcript.map(item => item.text || '').join(' ');
          } else if (Array.isArray(transcriptData)) {
            rawTranscript = transcriptData.map(item => item.text || item.transcript || '').join(' ');
          } else if (transcriptData.events && Array.isArray(transcriptData.events)) {
            rawTranscript = transcriptData.events.map(item => item.segs?.map(s => s.utf8).join('') || '').join(' ');
          } else if (transcriptData.text) {
            rawTranscript = transcriptData.text;
          } else {
            rawTranscript = JSON.stringify(transcriptData);
          }
          transcriptFetched = true; break;
        }
      } catch (apiError) { continue; }
    }

    if (!transcriptFetched) throw new Error('All API keys reached their limit or no CC available.');

    const cleanedTranscript = cleanTranscript(rawTranscript);
    if (cleanedTranscript.length < 200) throw new Error('Transcript is too short.');

    // ৪. Jina AI Scraping
    let scrapedSpecs = "";
    if (rawSpecs) {
      scrapedSpecs = rawSpecs;
    } else if (referenceUrl) {
      try {
        const jinaRes = await fetch(`https://r.jina.ai/${referenceUrl}`, {
          headers: { "X-Return-Format": "markdown", "X-Timeout": "20", "X-Wait-For-Selector": "body" }
        });
        if (jinaRes.ok) scrapedSpecs = await jinaRes.text();
        else throw new Error('Jina AI Server Error');
      } catch (e) {
        // 🚀 FIX: Silent error এর বদলে কাজ থামিয়ে ফ্রন্টএন্ডে মেসেজ পাঠানো হচ্ছে
        throw new Error('Website blocked scraping. Please copy-paste the data in the "Raw Specs" box.');
      }
    }

    // ৫. JSON Extraction (DeepSeek v4 Flash)
    const targetInstruction = targetName ? `\nCRITICAL INSTRUCTION: Use "${targetName}" as the 'deviceName'.\n` : '';

    const priceInstruction = manualPrice ? `\nCRITICAL PRICE INSTRUCTION: The user has explicitly provided the official Bangladesh price as "${manualPrice}". You MUST use this exact price in the JSON 'Pricing.priceVariants' array. Ignore all other prices in the website or video.\n` : '';

    const jsonPrompt = `
You are a precise data extraction engine. Analyze the following tech review transcript and competitor website data.
${targetInstruction}
${priceInstruction}

COMPETITOR WEBSITE DATA (From Jina AI or Raw Text):
"""
${scrapedSpecs ? scrapedSpecs : "No external data provided. Extract directly from the transcript and your knowledge."}
"""

YOUTUBE VIDEO TRANSCRIPT:
"""
${cleanedTranscript}
"""

Return ONLY a valid JSON object — no markdown fences, no explanation.

For 'fullSpecifications', you MUST present the data in this highly-detailed NESTED format. IMPORTANT: The keys below are just examples. You MUST dynamically add EVERY SINGLE specification found in the competitor data.
{
  "quickSpecs": { "Display": "...", "Processor": "...", "RAM": "...", "Storage": "...", "Battery": "...", "Camera": "...", "OS": "..." },
  "fullSpecifications": {
    "Design & Body": { 
      "Height": "...", "Width": "...", "Thickness": "...", "Weight": "...", "Build Material": "...", "Colors": "...", "<Add Any Other Field Found>": "..." 
    },
    "Display": { 
      "Display Type": "...", "Screen Size": "...", "Resolution": "...", "Refresh Rate": "...", "Screen Protection": "...", "Pixel Density": "...", "Notch": "...", "<Add Any Other Field Found>": "..." 
    },
    "Performance": { "Operating System": "...", "Chipset": "...", "CPU": "...", "GPU": "...", "<Add Any Other Field Found>": "..." },
    "Memory & Storage": { "RAM": "...", "Internal Storage": "...", "Storage Type": "...", "SD Card Slot": "...", "<Add Any Other Field Found>": "..." },
    "Main Camera": { "Camera Setup": "...", "Resolution": "...", "Camera Features": "...", "Video Recording": "...", "<Add Any Other Field Found>": "..." },
    "Selfie Camera": { "Camera Setup": "...", "Resolution": "...", "Video Recording": "...", "<Add Any Other Field Found>": "..." },
    "Battery & Charging": { "Battery Type": "...", "Capacity": "...", "Fast Charging": "...", "Reverse Charging": "...", "<Add Any Other Field Found>": "..." },
    "Connectivity & Sensors": { "Network": "...", "Wi-Fi": "...", "Bluetooth": "...", "USB": "...", "Fingerprint Sensor": "...", "Audio Jack": "...", "<Add Any Other Field Found>": "..." },
    "Pricing": { "priceVariants": [{ "ram": "8GB", "storage": "256GB", "price": 32999, "currency": "BDT", "variant": "INT", "type": "Official" }] }
  },
  "prosCons": { "pros": ["...", "..."], "cons": ["...", "..."] },
  "performanceRatings": { "regularUsage": 8, "gaming": 8, "multitasking": 8, "thermalManagement": 8 },
  "cameraRatings": { "outdoor": 8, "indoor": 8, "lowLight": 8, "zoom": 8 },
  "metaData": { "metaTitle": "...", "metaDescription": "...", "focusKeyword": "..." },
  "faqData": [
    { "question": "What is the price of [device] in Bangladesh?", "answer": "..." },
    { "question": "Is [device] good for gaming?", "answer": "..." },
    { "question": "What are the camera specs of [device]?", "answer": "..." },
    { "question": "What processor does [device] use?", "answer": "..." },
    { "question": "Is [device] worth buying in 2026?", "answer": "..." }
  ],
  "imageAltText": "...",
  "deviceName": "...",
  "reviewLanguage": "..."
}

Rules:
- DO NOT flatten the fullSpecifications. Keep the nested object structure.
- 🚀 ABSOLUTE SOURCE OF TRUTH: For the 'fullSpecifications' object, the COMPETITOR WEBSITE DATA is your PRIMARY and ONLY source of truth. DO NOT use the YouTube transcript to fill in dimensions, OS, Chipset, or hardware specs. The transcript is ONLY for quickSpecs, prosCons, and the review article!
- 🚀 NO "Not specified" OR "N/A": If a specification is genuinely missing from the competitor data, DO NOT write "Not specified", "N/A", or "Unknown". Instead, COMPLETELY OMIT that key from the JSON. Only output keys that have actual data. This keeps the UI clean.
- 🚀 DIMENSIONS SPLITTING: If the website says "Dimensions: 167.9 x 79.1 x 7.5 mm", you MUST split it and create distinct keys: 'Height': '167.9 mm', 'Width': '79.1 mm', 'Thickness': '7.5 mm'. Do this intelligently for any dimension format.
- 🚀 DYNAMIC FIELDS CAPTURE: Dynamically create new keys for EVERY SINGLE specification row found on the competitor website (e.g., 'Colors', 'Pixel Density', 'Notch', 'Ruggedness', 'Screen Protection'). Ensure 100% data coverage of the website.
- 🚀 CAPTURE ALL VARIANTS: If a field has multiple values (e.g., "128GB 4GB RAM, 128GB 6GB RAM, 256GB 8GB RAM"), list ALL of them. Do not truncate!
- 🚀 MULTIPLE PRICE VARIANTS: Extract ALL pricing variants into the 'priceVariants' array. Each variant must have: "ram" (e.g. "8GB"), "storage" (e.g. "256GB"), "price" (number, e.g. 32999), "currency" (always "BDT"), "variant" (e.g. "INT", "CN", "IND", or empty string if unknown), "type" (e.g. "Official", "Unofficial", or empty string if unknown).
- 🚀 STRICT CURRENCY FILTER & PRICE FALLBACK: If the user provided a manual price in the instructions, use it unconditionally. Otherwise, check the COMPETITOR WEBSITE DATA. CRITICAL: If the website contains prices in Indian Rupees (₹, INR), US Dollars ($), or Euros (€), YOU MUST REJECT THEM ENTIRELY. Do NOT use them. If the official Bangladesh price (BDT/Taka/Tk) is missing, deeply scan the YOUTUBE VIDEO TRANSCRIPT. Only extract the price if it is explicitly mentioned in BDT, Taka, or Tk. If no BD price is found anywhere, completely omit the price key or output "Not officially announced".
- CRITICAL: DO NOT include any citation markers, reference brackets (e.g., [1]), or source links in the JSON values.
- metaTitle MUST follow this exact format: "[Device Name] Price in Bangladesh 2026 | Review & Full Specs". focusKeyword MUST be the exact search query like "[Device Name] price in Bangladesh".
- 🚀 FAQ GENERATION: You MUST generate 5 to 8 FAQ entries in 'faqData'. Questions should be real search queries users ask about this device (e.g., price, gaming performance, camera quality, battery life, comparison with competitors). Answers should be 2-3 sentences each, factual and concise. Write FAQs in the same language as the transcript.
- 🚀 IMAGE ALT TEXT: Generate a descriptive 'imageAltText' for the device thumbnail (e.g., "Samsung Galaxy S25 Ultra front and back design with S Pen"). Keep it under 125 characters.
- Set reviewLanguage to "Bengali" if the transcript is in Bengali, otherwise "English".
- 🚀 ENGLISH TECHNICAL TERMS (CRITICAL FOR ALL OUTPUTS INCLUDING FAQs): ALL product names, brand names, model names, chipset names, software names, UI names, OS names, app names, feature names, and technical terms MUST remain in their original English form. NEVER transliterate them into Bengali or any other script. Examples: "OnePlus Nord 6" NOT "ওয়ানপ্লাস নর্ড ৬", "OxygenOS" NOT "অক্সিজেন ওএস", "Snapdragon 8 Elite" NOT "স্ন্যাপড্রাগন ৮ এলিট", "AMOLED" NOT "অ্যামোলেড".
`.trim();

    let rawJsonText = await callDeepSeek(jsonPrompt, true, "deepseek-v4-flash");
    rawJsonText = rawJsonText.replace(/```json|```/gi, '').trim();
    if (rawJsonText.toLowerCase().startsWith('json')) rawJsonText = rawJsonText.slice(4).trim();
    let extractedData;
    try {
      extractedData = JSON.parse(rawJsonText);
    } catch (parseError) {
      console.error("❌ [AI JSON ERROR] Raw Data:", rawJsonText); // রেন্ডার লগে ভুল JSON টি দেখাবে
      throw new Error("AI generated an invalid JSON format. Please try generating again.");
    }

    // 🚀 NEW: এই ৫টি লাইন server.js ফাইলে মিসিং ছিল, তাই ক্র্যাশ করছিল
    const focusKeyword = extractedData.metaData?.focusKeyword || targetName;
    const deviceName = targetName || extractedData.deviceName || 'this device';
    const reviewLanguage = extractedData.reviewLanguage || 'English';
    const isbengali = reviewLanguage.toLowerCase().includes('bengali');
    const fetchedPriceVariants = extractedData.fullSpecifications?.Pricing?.priceVariants;
    let fetchedPrice = 'Not officially announced';
    if (Array.isArray(fetchedPriceVariants) && fetchedPriceVariants.length > 0) {
      const prices = fetchedPriceVariants.map(v => typeof v.price === 'number' ? v.price : typeof v.price === 'string' ? parseInt(String(v.price).replace(/[^\d]/g, '')) : 0).filter(p => p > 0);
      fetchedPrice = prices.length > 0 ? `BDT ${Math.min(...prices).toLocaleString()}` : 'Not officially announced';
    } else {
      const legacyPrice = extractedData.fullSpecifications?.Pricing?.["Price in Bangladesh"];
      if (legacyPrice && typeof legacyPrice === 'string') fetchedPrice = legacyPrice;
    }

    const reviewPrompt = `
You are a passionate tech enthusiast and experienced smartphone reviewer who writes for a Bangladeshi tech blog.
Your job is to write an ORIGINAL, DETAILED review article about the ${deviceName}.

IMPORTANT — HOW TO USE THE TRANSCRIPT:
The transcript below is ONLY a rough reference for facts and features. DO NOT copy, paraphrase, or closely follow its sentence structure. Instead:
- Extract the KEY FACTS (specs, real-world observations, benchmarks, comparisons) from the transcript.
- Then write the review ENTIRELY IN YOUR OWN WORDS, as if you personally used the device and are sharing your honest opinion with friends.
- Add your own analysis, comparisons with competing phones, and practical advice.
- The final article should feel like it was written by a real person from their own experience, NOT like a rewritten transcript.

Target keyword: "${focusKeyword}"
Current Price in Bangladesh: "${fetchedPrice}"

Article structure (use these exact H2 headings, and freely add H3 sub-headings):
## Design & Build Quality
## Display Experience
## Performance & Gaming
## Camera System
## Battery Life & Charging
## Software & Features
## Final Verdict

Writing style rules:
- 🚀 AUDIENCE: Write for 12-15 year old readers. Use simple, conversational language. Short sentences. Avoid complex jargon — if you must use a technical term, briefly explain what it means in parentheses.
- 🚀 ORIGINALITY: DO NOT copy the transcript's wording. Rewrite everything in your own voice. Use casual, friendly tone. Include personal-sounding opinions like "honestly, this surprised me" or "for most people, this will be more than enough".
- 🚀 STRICT LANGUAGE: The entire article must be written in highly engaging and professional Bengali. Even if the YouTube transcript is in English or any other language, the final output must always be completely in Bengali.
- 🚀 ENGLISH TECHNICAL TERMS (MOST CRITICAL RULE): ALL product names, brand names, model names, model numbers, chipset names, processor names, software names, UI names, OS names, app names, sensor names, display technology names, charging technology names, and ANY technical terminology MUST stay in their ORIGINAL ENGLISH form. NEVER transliterate them into Bengali script.
  ✅ CORRECT: "OnePlus Nord 6", "OxygenOS", "Snapdragon 8 Elite", "AMOLED", "Gorilla Glass", "LPDDR5X RAM", "UFS 4.0", "120Hz refresh rate", "IP68", "HDR10+", "Dolby Atmos", "50MP Sony IMX906 sensor"
  ❌ WRONG: "ওয়ানপ্লাস নর্ড ৬", "অক্সিজেন ওএস", "স্ন্যাপড্রাগন ৮ এলিট", "অ্যামোলেড", "গরিলা গ্লাস"
  The surrounding sentence is in Bengali, but the technical term stays English. Example: "OnePlus Nord 6-এর display অনেকটা flagship-level মনে হয়।"
- 🚀 LENGTH: Target 2500-3500+ words. Add H3 sub-headings for readability. If you run out of real information, stop naturally. DO NOT hallucinate.
- Never use AI filler words. Never start with "I". Never write "In this review".
- Do NOT mention YouTube, the video, the creator, or any call to action.
- Do NOT include pros/cons lists or specs tables in the text.
- Do NOT add a "Conclusion" heading. End with a natural final verdict.
- Mention the device's price naturally in the "Final Verdict" section.
- Do NOT include any citations, reference brackets (like [1]), or source links.
- Do NOT mention that this article was written by AI.

Transcript (USE AS FACT REFERENCE ONLY, DO NOT COPY):
"""
${cleanedTranscript}
"""
`.trim();

    let markdownContent = await callDeepSeek(reviewPrompt, false, "deepseek-v4-pro");
    markdownContent = markdownContent.replace(/\[cite[^\]]*\]/gi, '').trim();

    // ৭. Save to MongoDB
    let slug = slugify(extractedData.metaData.focusKeyword).substring(0, 80);
    let slugCounter = 2;
    while (await Post.findOne({ slug })) { slug = `${slugify(extractedData.metaData.focusKeyword).substring(0, 80)}-${slugCounter++}`; }

    const newPost = new Post({
      title: extractedData.metaData.metaTitle, slug, content: markdownContent,
      quickSpecs: extractedData.quickSpecs, fullSpecifications: extractedData.fullSpecifications,
      prosCons: extractedData.prosCons, performanceRatings: extractedData.performanceRatings,
      cameraRatings: extractedData.cameraRatings, thumbnail: thumbnail ?? `https://img.youtube.com/vi/${derivedVideoId}/hqdefault.jpg`,
      videoId: derivedVideoId, originalCreator: originalCreator ?? 'Unknown',
      metaData: extractedData.metaData, faqData: extractedData.faqData || [],
      imageAltText: extractedData.imageAltText || '', status: 'Draft',
    });

    await newPost.save();

    // 🚀 কাজ শেষ! হার্টবিট বন্ধ করে ফাইনাল রেসপন্স পাঠানো হচ্ছে
    clearInterval(keepAlive);
    res.write(JSON.stringify({ success: true, message: 'Post generated!', postSlug: slug }));
    res.end();

  } catch (error) {
    clearInterval(keepAlive);
    res.write(JSON.stringify({ error: error.message || 'Server Error' }));
    res.end();
  }
});

const PORT = process.env.PORT || 10000;

// ── Health Check Route ──
app.get('/', (req, res) => {
  res.status(200).json({ status: 'success', message: 'AI Microservice is running perfectly! 🚀' });
});

app.post('/api/custom-generate', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.MICROSERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Access' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  const keepAlive = setInterval(() => { res.write(' '); }, 15000);

  try {
    const { title, prompt } = req.body;
    if (!prompt) throw new Error('Prompt is required.');

    const systemPrompt = `
You are an expert tech blogger for a Bangladeshi audience.
Write an engaging, SEO-optimized, detailed tech article in Bengali based on the user's instructions.

Topic/Instructions: "${prompt}"
${title ? `Suggested Title: "${title}"` : ""}

Rules:
- Write ENTIRELY in professional Bengali.
- Keep technical terms (Brands, Processors, OS, UI, Sensors) in their original English form. NEVER transliterate them into Bengali script.
- Format output in Markdown. Use H2 (##) and H3 (###) for structure.
- Do NOT include frontmatter or markdown code block fences (\`\`\`markdown). Output the raw markdown text directly.
- Ensure the article is detailed, informative, and engaging for tech enthusiasts.
`.trim();

    let markdownContent = await callDeepSeek(systemPrompt, false, "deepseek-v4-pro");
    markdownContent = markdownContent.replace(/\[cite[^\]]*\]/gi, '').trim();

    clearInterval(keepAlive);
    res.write(JSON.stringify({ success: true, content: markdownContent }));
    res.end();

  } catch (error) {
    clearInterval(keepAlive);
    res.write(JSON.stringify({ error: error.message || 'Server Error' }));
    res.end();
  }
});

app.listen(PORT, () => console.log(`🚀 AI Worker running on port ${PORT}`));