const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

// === CONFIGURATION === //
const model = process.env.AI_MODEL || 'gemini'; // Options: 'gemini' or 'azure'

// --- Azure OpenAI Settings --- //
const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

// --- Gemini Settings --- //
const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

// === GET GIT DIFF: PR-safe and accurate === //
let diff = '';
try {
  const base = process.env.GITHUB_BASE_REF || 'main';
  execSync(`git fetch origin ${base}`, { stdio: 'inherit' });
  diff = execSync(`git diff origin/${base}...HEAD`, { stdio: 'pipe' }).toString();

  if (!diff.trim()) {
    console.log("✅ No changes found in PR. Skipping AI review.");
    process.exit(0);
  }

  console.log("✅ Diff generated from PR changes.");
} catch (e) {
  console.error("❌ Failed to get diff from PR branch:", e.message);
  process.exit(1);
}

// === PROMPT === //
const prompt = `You are an expert software engineer and code reviewer specializing in clean code, security, performance, and maintainability.

Please review the following code diff and respond in **strict JSON format**.

Your JSON output must follow this structure:

{
  "overall_summary": "Brief summary of the changes and your general impression.",
  "positive_aspects": ["List of good practices observed."],
  "issues": [
    {
      "severity": "[INFO|MINOR|MAJOR|CRITICAL]",
      "title": "Short title or label of the issue",
      "description": "Detailed explanation of the issue or concern.",
      "suggestion": "Proposed fix or recommendation.",
      "file": "Relative path to file (e.g., .github/scripts/ai-review.js)",
      "line": "Line number(s) where the issue occurs",
      "code_snippet": "Relevant snippet of the affected code"
    }
  ]
}

Respond with only a single valid JSON object. No Markdown, headers, or commentary.

Here is the code diff:
\`\`\`diff\n${diff}\n\`\`\``;

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
  return res.data.choices?.[0]?.message?.content?.trim() || "No response from Azure OpenAI.";
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

// === Helper to Find Snippet Line Range === //
function matchSnippetInFile(filePath, codeSnippet) {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const snippetLines = codeSnippet.trim().split('\n').map(line => line.trim());

  for (let i = 0; i <= lines.length - snippetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < snippetLines.length; j++) {
      if (lines[i + j].trim() !== snippetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start: i + 1, end: i + snippetLines.length };
    }
  }
  return null;
}

// === Main Logic === //
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

    console.log("\n🔍 AI Code Review Output:\n");
    console.log(review);

    const cleaned = review
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    console.log("\n🔍 Cleaned JSON Output:\n");
    console.log(cleaned);

    const parsed = JSON.parse(cleaned);

    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const repo = process.env.GITHUB_REPOSITORY;
    const ref = process.env.GITHUB_REF;
    const [owner, repoName] = repo.split('/');
    const match = ref.match(/refs\/pull\/(\d+)\/merge/);
    const prNumber = match?.[1];
    const commitId = github.context.payload.pull_request.head.sha;

    for (const issue of parsed.issues || []) {
      const filePath = path.resolve(process.cwd(), issue.file);
      const result = matchSnippetInFile(filePath, issue.code_snippet);
      if (result) {
        issue.matched_line = result.start;
        console.log(`✅ Matched "${issue.title}" at ${issue.file}:${result.start}`);
      } else {
        issue.matched_line = null;
        console.warn(`❌ Could not match snippet for "${issue.title}" in ${issue.file}`);
      }
    }

    for (const issue of parsed.issues || []) {
      if (!issue.matched_line) continue;
      let bgColor = '#e6ffed'; // default green for LOW
let severityLabel = 'LOW';
if (issue.severity === 'CRITICAL' || issue.severity === 'MAJOR') {
  bgColor = '#ffeef0'; // red for HIGH
  severityLabel = 'HIGH';
} else if (issue.severity === 'MINOR') {
  bgColor = '#fff5b1'; // orange for MEDIUM
  severityLabel = 'MEDIUM';
}

const body = `
<div style="background-color:${bgColor}; padding:12px; border-radius:6px;">
  <strong>🤖 ${issue.title}</strong><br/>
  <strong>Severity:</strong> ${severityLabel}<br/><br/>
  ${issue.description}<br/><br/>
  <strong>Suggestion:</strong><br/>
  ${issue.suggestion}
</div>`;

      await octokit.rest.pulls.createReviewComment({
        owner,
        repo: repoName,
        pull_number: prNumber,
        commit_id: commitId,
        path: issue.file,
        line: issue.matched_line,
        side: 'RIGHT',
        body
      });

      console.log(`💬 Posted inline comment: ${issue.title}`);
    }
  } catch (err) {
    console.error("❌ Error during AI review:", err.response?.data || err.message);
  }
}

reviewCode();
