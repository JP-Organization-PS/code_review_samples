const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');

const model = process.env.AI_MODEL || 'gemini';
const azureKey = process.env.AZURE_OPENAI_KEY;
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const geminiKey = process.env.GEMINI_API_KEY;
const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key=${geminiKey}`;

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

const basePrompt = `You are an expert software engineer and code reviewer known for your attention to detail and deep understanding of clean code, performance optimization, security, and maintainability.

Your task is to **analyze the following code diff** and generate a professional code review in structured **GitHub-compatible Markdown**.

Please use the following format in your response:

---

### 📘 Overview
Provide a high-level summary of what this code change does. Mention the overall intent and affected components.

---

### ✅ Highlights
List good practices observed in the diff, such as clear naming, good structure, efficiency, or use of best practices.

- Example: Uses descriptive variable names.
- Example: Handles edge cases effectively.

---

### ⚠️ Issues & Suggestions

Present any concerns, bugs, anti-patterns, or areas for improvement using a table.

| Severity    | Issue Description                                                                 |
|-------------|-------------------------------------------------------------------------------------|
| [INFO]      | Minor note or general suggestion.                                                  |
| [MINOR]     | Small improvement that can enhance readability or maintainability.                 |
| [MAJOR]     | Likely bug or problematic pattern affecting correctness, performance, or design.  |
| [CRITICAL]  | Definite bug, security risk, or significant architectural issue.                   |

---

### 💡 Suggestions

Provide concrete code suggestions using code blocks where possible. Aim to show improved or idiomatic alternatives, if applicable.

Respond ONLY with the formatted review above — **do not add explanation outside the structure**.`;

const prompt = `${basePrompt}\n\nHere is the code diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

async function runWithAzureOpenAI() {
  console.log("\ud83d\udd39 Using Azure OpenAI...");
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
  console.log("\ud83d\udd36 Using Gemini...");
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

async function postCommentToGitHubPR(reviewText) {
  try {
    const token = process.env.GITHUB_TOKEN;
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
    const prMatch = process.env.GITHUB_REF.match(/refs\/pull\/(\d+)\/merge/);
    const prNumber = prMatch?.[1];

    if (!token || !owner || !repo || !prNumber) throw new Error("Missing PR context");

    const octokit = github.getOctokit(token);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: reviewText
    });

    console.log(`\u2705 Comment posted to PR #${prNumber}`);
  } catch (err) {
    console.error("\u274c Failed to post PR comment:", err.message);
  }
}

async function reviewCode() {
  try {
    let review = model === 'azure' ? await runWithAzureOpenAI() : await runWithGemini();
    console.log("\n\ud83d\udd0d AI Code Review Output:\n");
    console.log(review);

    if (process.env.GITHUB_TOKEN) {
      await postCommentToGitHubPR(review);
    }
  } catch (err) {
    console.error("\u274c Error during AI review:", err.response?.data || err.message);
  }
}

reviewCode();
