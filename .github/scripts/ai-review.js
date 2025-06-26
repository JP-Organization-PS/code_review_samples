const axios = require('axios');
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
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${geminiKey}`;

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
You are an expert software engineer. Review the following code diff and provide JSON feedback with inline suggestions.

Use this format:

[
  {
    "file": "relative/path/to/file.py",
    "line": 2,
    "severity": "[MINOR]",
    "issue": "Brief description of the issue.",
    "suggestion": "What to improve or fix.",
    "code": "Original code line from diff",
    "fixed_code": "Improved or corrected version of the code line"
  }
]

Return only valid JSON.

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
      const body = `
**Issue:** ${comment.severity} ${comment.issue}

**Suggestion:**
${comment.suggestion}

**Original Code:**
\`\`\`js
${comment.code}
\`\`\`

**Rewritten Code:**
\`\`\`js
${comment.fixed_code || comment.code}
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

// === Main === //
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

    const jsonMatch = rawResponse.match(/```json([\s\S]*?)```/);
    const jsonText = jsonMatch ? jsonMatch[1] : rawResponse;

    let comments = [];
    try {
      comments = JSON.parse(jsonText);
    } catch (err) {
      console.error("❌ Failed to parse AI response JSON:", err.message);
      return;
    }

    if (comments.length === 0) {
      console.log("ℹ️ No inline suggestions found.");
      return;
    }

    await postInlineComments(comments);
  } catch (err) {
    console.error("❌ Error during AI review:", err.message);
  }
}

reviewCode();
