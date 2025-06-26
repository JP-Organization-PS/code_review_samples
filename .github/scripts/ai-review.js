const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const github = require('@actions/github');

// === CONFIGURATION === //
const model = process.env.AI_MODEL || 'gemini';

// --- Azure OpenAI Settings --- //
const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

// --- Gemini Settings --- //
const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

// === GET GIT DIFF === //
let diff = '';
try {
  const base = process.env.GITHUB_BASE_REF || 'main';
  execSync(`git fetch origin ${base}`, { stdio: 'inherit' });
  diff = execSync(`git diff origin/${base}...HEAD`, { stdio: 'pipe' }).toString();
  if (!diff.trim()) {
    console.log("✅ No changes to review. Skipping AI code review.");
    process.exit(0);
  }
} catch (e) {
  console.error("❌ Failed to get git diff:", e.message);
  process.exit(1);
}

// === PROMPT === //
const prompt = `
You are an expert software engineer. Review the following code diff and return only a valid JSON array of suggestions.

STRICTLY return only the array in this format. Do not add any explanation or extra text.

[
  {
    "file": "relative/path/to/file.py",
    "line": 2,
    "severity": "[MINOR]",
    "issue": "Brief description of the issue.",
    "suggestion": "What to improve or fix.",
    "fixed_code": "Improved or corrected version of the code line"
  }
]

Here is the code diff:
\`\`\`diff
${diff}
\`\`\`
`;

// === AI Clients === //
async function runWithAzureOpenAI() {
  console.log("🔷 Using Azure OpenAI...");
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

  return res.data.choices?.[0]?.message?.content?.trim() || "[]";
}

async function runWithGemini() {
  console.log("🔶 Using Gemini...");
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
        temperature: 0.2,
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

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
}

// === Extract Clean JSON from LLM === //
function extractJsonFromResponse(text) {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = text.substring(start, end + 1).trim();
    try {
      JSON.parse(sliced); // validate
      return sliced;
    } catch {
      console.warn("⚠️ JSON slice looks malformed.");
    }
  }

  console.warn("⚠️ No valid JSON block found.");
  return "[]";
}

// === Get Actual Code Line From File === //
function getLineFromFile(filePath, lineNumber) {
  try {
    const fullPath = path.resolve(process.env.GITHUB_WORKSPACE || '.', filePath);
    const fileLines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    return fileLines[lineNumber - 1] || '';
  } catch (err) {
    console.warn(`⚠️ Could not read ${filePath}:${lineNumber} - ${err.message}`);
    return '';
  }
}

// === Post Inline Comments === //
async function postInlineComments(comments) {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set.");

    const octokit = github.getOctokit(token);
    const [owner, repoName] = process.env.GITHUB_REPOSITORY.split('/');
    const prNumber = github.context.payload.pull_request.number;
    const commitSha = github.context.payload.pull_request.head.sha;

    for (const comment of comments) {
      const actualCode = getLineFromFile(comment.file, comment.line);

      const body = `
**Issue:** ${comment.severity} ${comment.issue}

**Suggestion:**
${comment.suggestion}

**Original Code:**
\`\`\`js
${actualCode}
\`\`\`

**Rewritten Code:**
\`\`\`js
${comment.fixed_code || actualCode}
\`\`\`
`;

      await octokit.rest.pulls.createReviewComment({
        owner,
        repo: repoName,
        pull_number: prNumber,
        commit_id: commitSha,
        path: comment.file,
        line: comment.line,
        side: "RIGHT",
        body
      });

      console.log(`💬 Posted inline comment on ${comment.file}:${comment.line}`);
    }
  } catch (err) {
    console.error("❌ Failed to post inline comments:", err.message);
  }
}

// === Main Logic === //
async function reviewCode() {
  try {
    let rawResponse = '';

    if (model === 'azure') {
      rawResponse = await runWithAzureOpenAI();
    } else if (model === 'gemini') {
      rawResponse = await runWithGemini();
    } else {
      throw new Error("Unsupported model: use 'azure' or 'gemini'");
    }

    console.log("\n🧠 Raw AI Response:\n", rawResponse);

    let comments = [];
    try {
      const cleanJson = extractJsonFromResponse(rawResponse);
      console.log("🧪 Clean JSON:\n", cleanJson);
      comments = JSON.parse(cleanJson);
    } catch (err) {
      console.error("❌ Failed to parse AI response JSON:", err.message);
      return;
    }

    if (!Array.isArray(comments) || comments.length === 0) {
      console.log("ℹ️ No inline suggestions found.");
      return;
    }

    await postInlineComments(comments);
  } catch (err) {
    console.error("❌ Error during AI review:", err.message);
  }
}

reviewCode();