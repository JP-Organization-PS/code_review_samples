const axios = require('axios');
const { execSync } = require('child_process');

// === CONFIGURATION === //
const model = process.env.AI_MODEL || 'gemini'; // 'azure' or 'gemini'

// --- Azure OpenAI Settings --- //
const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

// --- Gemini Settings --- //
const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

// === GET DIFF === //
let diff = '';
try {
  diff = execSync('git diff HEAD~1 HEAD', { stdio: 'pipe' }).toString();
  if (!diff.trim()) throw new Error('Empty diff');
} catch (e) {
  console.warn("Git diff failed. Using fallback diff.");
  diff = `diff --git a/index.js b/index.js
          index 0000001..0ddf2ba
          --- a/index.js
          +++ b/index.js
          @@ -0,0 +1,3 @@
          +function greet(name) {
          +  return "Hello " + name;
          +}`;
}

// === PROMPT === //
const prompt = `
You are an expert software engineer and code reviewer specializing in clean code, security, performance, and maintainability.

Please carefully review the following code diff and provide detailed feedback.

Your response should include:

1. **Overall Summary** – A brief summary of the change and your general impression.
2. **Positive Aspects** – Highlight any good practices or improvements made.
3. **Issues/Concerns** – Mention any bugs, anti-patterns, security concerns, or performance problems.
4. **Suggestions** – Recommend improvements, better design patterns, or more idiomatic approaches.
5. **Severity Tags** – Use tags like [INFO], [MINOR], [MAJOR], [CRITICAL] before each issue/suggestion.

Respond in Markdown format to make it suitable for posting directly on GitHub PRs.

Here is the code diff:
\`\`\`diff
${diff}
\`\`\`
`;

async function runWithAzureOpenAI() {
  console.log("Using Azure OpenAI...");
  const res = await axios.post(
    `${azureEndpoint}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-03-01-preview`,
    {
      messages: [
        { role: "system", content: "You are a professional code reviewer." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 4096
    },
    {
      headers: {
        "api-key": azureKey,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices?.[0]?.message?.content?.trim() || "No response from Azure OpenAI.";
}

async function runWithGemini() {
  console.log("Using Gemini...");
  const res = await axios.post(
    geminiEndpoint,
    {
      contents: [
        {
          parts: [{ text: prompt }],
          role: "user"
        }
      ],
      generationConfig: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 8192
      }
    },
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "No response from Gemini.";
}

async function reviewCode() {
  try {
    let review = '';

    if (model === 'azure') {
      review = await runWithAzureOpenAI();
    } else if (model === 'gemini') {
      review = await runWithGemini();
    } else {
      throw new Error("Unsupported model: use 'azure' or 'gemini'");
    }

    console.log("\nAI Code Review Output:\n");
    console.log(review);
  } catch (err) {
    console.error("Error during AI review:", err.response?.data || err.message);
  }
}

reviewCode();
