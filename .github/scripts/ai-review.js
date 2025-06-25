const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');

// ENV configuration
const model = process.env.AI_MODEL || 'gemini';
const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

// Get git diff from PR
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

// Prompt template
const basePrompt = `You are an expert software engineer and code reviewer known for your attention to detail and deep understanding of clean code, performance optimization, security, and maintainability.

Your task is to **analyze the following code diff** and generate a professional code review in structured **GitHub-compatible Markdown**.

Please use the following format in your response:

---

### 📘 Overview
Provide a high-level summary of what this code change does.

---

### ✅ Highlights
List good practices.

---

### ⚠️ Issues & Suggestions

| Severity    | Issue Description                                                                 |
|-------------|-------------------------------------------------------------------------------------|
| [INFO]      | Minor note or general suggestion.                                                  |
| [MINOR]     | Small improvement.                                                                 |
| [MAJOR]     | Likely bug.                                                                        |
| [CRITICAL]  | Definite bug or security risk.                                                     |

---

### 💡 Suggestions
Use code blocks for suggestions.

Respond ONLY with the structured markdown above.`;

// Full prompt with diff
const prompt = `${basePrompt}\n\nHere is the code diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

// Call Azure OpenAI
async function runWithAzureOpenAI() {
  console.log("🔹 Using Azure OpenAI...");
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

// Call Gemini API
async function runWithGemini() {
  console.log("🔷 Using Gemini...");
  const res = await axios.post(
    geminiEndpoint,
    {
      contents: [{ parts: [{ text: prompt }], role: "user" }],
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

// Post each issue as a separate comment
async function postCommentsPerIssue(reviewText) {
  try {
    const token = process.env.GITHUB_TOKEN;
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    const prMatch = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/);
    const prNumber = prMatch?.[1];

    if (!token || !owner || !repo || !prNumber) throw new Error("Missing PR context");

    const octokit = github.getOctokit(token);

    // Extract issue table
    const issueSectionMatch = reviewText.match(/### ⚠️ Issues & Suggestions([\s\S]*?)---/);
    const issueTable = issueSectionMatch?.[1] || '';

    const issueRegex = /\| \[([A-Z]+)\]\s+\|\s+(.*?)\s+\|/g;
    const issues = [];
    let match;
    while ((match = issueRegex.exec(issueTable)) !== null) {
      issues.push(`**Severity:** ${match[1]}\n\n${match[2]}`);
    }

    if (!issues.length) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: reviewText
      });
      console.log("🟢 Posted single summary comment (no individual issues found).");
      return;
    }

    for (const issue of issues) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `### ⚠️ Code Review Issue\n\n${issue}\n\n_You may resolve this conversation once addressed._`
      });
    }

    console.log(`✅ Posted ${issues.length} individual issue comments to PR #${prNumber}`);
  } catch (err) {
    console.error("❌ Failed to post comments:", err.message);
  }
}

// Run the full flow
async function reviewCode() {
  try {
    const review = model === 'azure' ? await runWithAzureOpenAI() : await runWithGemini();
    console.log("\n🔍 AI Review:\n");
    console.log(review);
    if (process.env.GITHUB_TOKEN) {
      await postCommentsPerIssue(review);
    }
  } catch (err) {
    console.error("❌ Error during AI review:", err.response?.data || err.message);
  }
}

reviewCode();
