const axios = require('axios');
const { execSync } = require('child_process');
const github = require('@actions/github');

// === CONFIGURATION === //
const model = process.env.AI_MODEL || 'gemini'; // Options: 'gemini' or 'azure'

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
  diff = execSync('git diff origin/main...HEAD', { stdio: 'pipe' }).toString();
  if (!diff.trim()) {
    console.log("✅ No changes detected — skipping AI code review.");
    process.exit(0); // Exit without running review
  }
} catch (e) {
  console.error("❌ Failed to get git diff:", e.message);
  process.exit(1);
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

    if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && process.env.GITHUB_REF) {
      await postCommentToGitHubPR(review);
    }
  } catch (err) {
    console.error("❌ Error during AI review:", err.response?.data || err.message);
  }
}

reviewCode();
