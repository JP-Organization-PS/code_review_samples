const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const github = require('@actions/github');

const model = process.env.AI_MODEL || 'gemini';

const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

let diff = '';
let prompt = '';

async function getDiffFromLastTwoCommits() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    const prNumber = github.context.payload.pull_request.number;

    const commits = await octokit.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });
    const commitCount = commits.data.length;

    if (commitCount < 2) {
      return execSync(`git diff HEAD~1 HEAD`).toString();
    } else {
      const baseSha = commits.data[commitCount - 2].sha;
      const headSha = commits.data[commitCount - 1].sha;
      return execSync(`git diff ${baseSha} ${headSha}`).toString();
    }
  } catch (e) {
    console.error("❌ Failed to get commit diff:", e.message);
    process.exit(1);
  }
}

function buildPrompt(diff) {
  return `You are an expert software engineer. Review the following code diff and return only a valid JSON array of suggestions.

STRICTLY return only the array in this format. Do not add any explanation or extra text.

[
  {
    "file": "relative/path/to/file.js",
    "line": 2,
    "severity": "[MINOR]",
    "issue": "Brief description of the issue.",
    "suggestion": "What to improve or fix.",
    "code": "Code line from diff",
    "fixed_code": "Improved version of the code line"
  }
]

Here is the code diff:
\`\`\`diff
${diff}
\`\`\`
`;
}

async function runWithGemini(prompt) {
  const res = await axios.post(
    geminiEndpoint,
    {
      contents: [{ parts: [{ text: prompt }], role: "user" }],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 8192 }
    },
    { headers: { "Content-Type": "application/json" } }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";
}

async function runWithAzureOpenAI(prompt) {
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

function extractJsonFromResponse(text) {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = text.substring(start, end + 1).trim();
    try {
      JSON.parse(sliced);
      return sliced;
    } catch {
      console.warn("⚠️ JSON slice looks malformed.");
    }
  }
  return "[]";
}

async function findDiffPositionUsingGitHubAPI(filePath, expectedLine, codeSnippet) {
  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = github.context.payload.pull_request.number;
  const octokit = github.getOctokit(token);

  const files = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: prNumber });
  const prFile = files.data.find(f => f.filename === filePath);
  if (!prFile || !prFile.patch) return null;

  const patchLines = prFile.patch.split('\n');
  let position = 0;
  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (line.startsWith('+') && !line.startsWith('+++')) {
      position++;
      const code = line.substring(1).trim();
      if (code === codeSnippet.trim()) {
        return position;
      }
    } else if (!line.startsWith('-') && !line.startsWith('---')) {
      position++;
    }
  }

  return null;
}

async function postInlineComments(comments) {
  const token = process.env.GITHUB_TOKEN;
  const octokit = github.getOctokit(token);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const prNumber = github.context.payload.pull_request.number;
  const commitSha = github.context.payload.pull_request.head.sha;

  for (const comment of comments) {
    const position = await findDiffPositionUsingGitHubAPI(comment.file, comment.line, comment.code);
    if (!position) {
      console.warn(`⚠️ Skipping comment: cannot map ${comment.file}:${comment.line}`);
      continue;
    }

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
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      path: comment.file,
      position,
      body
    });

    console.log(`💬 Posted inline comment on ${comment.file}:${comment.line} (patch position ${position})`);
  }
}

(async function reviewCode() {
  try {
    diff = await getDiffFromLastTwoCommits();
    prompt = buildPrompt(diff);

    let rawResponse = '';
    if (model === 'azure') {
      rawResponse = await runWithAzureOpenAI(prompt);
    } else if (model === 'gemini') {
      rawResponse = await runWithGemini(prompt);
    } else {
      throw new Error("Unsupported model: use 'azure' or 'gemini'");
    }

    console.log("\n🧠 Raw AI Response:\n", rawResponse);

    const cleanJson = extractJsonFromResponse(rawResponse);
    const comments = JSON.parse(cleanJson);

    if (!Array.isArray(comments) || comments.length === 0) {
      console.log("ℹ️ No inline suggestions found.");
      return;
    }

    await postInlineComments(comments);
  } catch (err) {
    console.error("❌ Error during AI review:", err.message);
  }
})();