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

let diff = '';
try {
  const base = process.env.GITHUB_BASE_REF || 'main';

  // Ensure base branch is fetched
  execSync(`git fetch origin ${base}`, { stdio: 'inherit' });

  // Get the last 2 commits exclusive to the PR branch
  const commits = execSync(`git rev-list origin/${base}..HEAD --reverse`)
    .toString()
    .trim()
    .split('\n');

  if (commits.length < 2) {
    console.warn("⚠️ Less than 2 commits found in PR branch. Using last commit only.");
    const lastCommit = commits[commits.length - 1];
    diff = execSync(`git diff ${lastCommit}^ ${lastCommit}`, { stdio: 'pipe' }).toString();
  } else {
    const lastTwo = commits.slice(-2);
    diff = execSync(`git diff ${lastTwo[0]} ${lastTwo[1]}`, { stdio: 'pipe' }).toString();
  }

  if (!diff.trim()) {
    console.log("✅ No changes found in the last 2 PR commits. Skipping AI review.");
    process.exit(0);
  }
} catch (e) {
  console.error("❌ Failed to get diff from last 2 commits in PR branch:", e.message);
  process.exit(1);
}



// === PROMPT === //
const prompt = `
You are an expert software engineer and code reviewer specializing in clean code, security, performance, and maintainability.

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

// === Post PR Comment === //
async function postCommentToGitHubPR(reviewText) {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set.");

    const octokit = github.getOctokit(token);
    const repo = process.env.GITHUB_REPOSITORY;
    const ref = process.env.GITHUB_REF;

    if (!repo || !ref) throw new Error("GITHUB_REPOSITORY or GITHUB_REF is not set.");

    const [owner, repoName] = repo.split('/');
    const match = ref.match(/refs\/pull\/(\d+)\/merge/);
    const prNumber = match?.[1];

    if (!prNumber) throw new Error("Cannot determine PR number from GITHUB_REF.");

    await octokit.rest.issues.createComment({
      owner,
      repo: repoName,
      issue_number: prNumber,
      body: reviewText
    });

    console.log(`✅ Posted AI review as PR comment on #${prNumber}`);
  } catch (err) {
    console.error("❌ Failed to post comment to GitHub PR:", err.message);
  }
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

    // 🧼 Sanitize response: remove markdown fences
    const cleaned = review
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

    console.log("\n🔍 Cleaned JSON Output:\n");
    console.log(cleaned);

    let parsed;
    parsed = JSON.parse(cleaned);

    for (const issue of parsed.issues || []) {
      console.log("\n🔍 Parsed Issues:\n");
      console.log(issue);
      const filePath = path.resolve(process.cwd(), issue.file);
      const result = matchSnippetInFile(filePath, issue.code_snippet);
      if (result) {
        issue.matched_line_range = `${result.start}-${result.end}`;
        console.log(`✅ Matched "${issue.title}" at ${issue.file}:${issue.matched_line_range}`);
      } else {
        issue.matched_line_range = null;
        console.warn(`❌ Could not match snippet for "${issue.title}" in ${issue.file}`);
      }
    }

  } catch (err) {
    console.error("❌ Error during AI review:", err.response?.data || err.message);
  }
}

reviewCode();
