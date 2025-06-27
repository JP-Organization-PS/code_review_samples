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

// === GET GIT DIFF FOR LAST TWO COMMITS === //
let diff = '';
let commitDetails = []; // To store details of the last two commits

try {
    // Ensure we have enough history for the last two commits
    // Fetch shallowly if needed, or ensure full history if the action runs on `push` event.
    // For a PR, GITHUB_SHA is the merge commit, so we need to go back from there.
    execSync(`git fetch origin ${process.env.GITHUB_BASE_REF || 'main'}`, { stdio: 'inherit' });

    // Get the SHA of the current HEAD and the commit two before HEAD
    // This assumes the current workflow run is on the latest commit of the branch/PR.
    // If you are reviewing a PR merge commit, then HEAD~1 is the tip of the PR branch.
    // If reviewing individual pushes, HEAD is the latest push.
    // For reviewing "the last two commits pushed", you'd typically review HEAD and HEAD~1.

    const latestCommitSha = execSync('git rev-parse HEAD').toString().trim();
    let secondToLastCommitSha = '';

    try {
        secondToLastCommitSha = execSync('git rev-parse HEAD~1').toString().trim();
    } catch (e) {
        console.log("Only one commit found in the current branch. Reviewing only the latest commit.");
        secondToLastCommitSha = latestCommitSha; // Fallback to diffing latest vs its parent if only one commit
    }

    let thirdToLastCommitSha = '';
    try {
        thirdToLastCommitSha = execSync('git rev-parse HEAD~2').toString().trim();
    } catch (e) {
        // If there are less than 2 commits, this will fail.
        // In this case, we will diff HEAD~1 against its parent (if it exists), or HEAD against its parent.
        // We'll handle the diff logic more robustly below.
    }


    // Get details of the last two relevant commits for the prompt
    // For the latest commit
    const latestCommitInfo = execSync(`git log -1 --pretty=format:"%h%n%an%n%s" ${latestCommitSha}`).toString().trim().split('\n');
    commitDetails.push({
        hash: latestCommitInfo[0],
        author: latestCommitInfo[1],
        subject: latestCommitInfo[2],
        isLatest: true
    });

    // For the commit before the latest
    if (secondToLastCommitSha && secondToLastCommitSha !== latestCommitSha) { // Ensure it's a distinct commit
        const secondCommitInfo = execSync(`git log -1 --pretty=format:"%h%n%an%n%s" ${secondToLastCommitSha}`).toString().trim().split('\n');
        commitDetails.push({
            hash: secondCommitInfo[0],
            author: secondCommitInfo[1],
            subject: secondCommitInfo[2],
            isLatest: false
        });
    }

    console.log("Fetching diffs for the last two commits...");

    let diff1 = '';
    let diff2 = '';

    // Diff for the latest commit (HEAD vs HEAD~1)
    try {
        diff1 = execSync(`git diff ${latestCommitSha}~1...${latestCommitSha}`, { stdio: 'pipe' }).toString();
    } catch (e) {
        // This might happen if HEAD is the initial commit with no parent
        console.warn(`Could not get diff for latest commit (${latestCommitSha}) against its parent. It might be the initial commit. Error: ${e.message}`);
    }

    // Diff for the second to last commit (HEAD~1 vs HEAD~2)
    if (secondToLastCommitSha && secondToLastCommitSha !== latestCommitSha) { // Only if there's a distinct second commit
        try {
            diff2 = execSync(`git diff ${secondToLastCommitSha}~1...${secondToLastCommitSha}`, { stdio: 'pipe' }).toString();
        } catch (e) {
            console.warn(`Could not get diff for second to last commit (${secondToLastCommitSha}) against its parent. It might be the initial or only commit. Error: ${e.message}`);
        }
    }


    // Combine diffs, indicating which commit they belong to
    if (diff1) {
        diff += `--- Diff for Latest Commit (${commitDetails[0].hash}): ${commitDetails[0].subject} by ${commitDetails[0].author} ---\n`;
        diff += diff1 + '\n\n';
    } else {
        console.log(`No diff generated for latest commit ${commitDetails[0].hash}.`);
    }

    if (diff2) {
        diff += `--- Diff for Second-to-Last Commit (${commitDetails[1].hash}): ${commitDetails[1].subject} by ${commitDetails[1].author} ---\n`;
        diff += diff2 + '\n\n';
    } else if (secondToLastCommitSha && secondToLastCommitSha !== latestCommitSha) {
         console.log(`No diff generated for second-to-last commit ${commitDetails[1].hash}.`);
    }


    if (!diff.trim()) {
        console.log("✅ No significant changes detected in the last two commits to review. Skipping AI code review.");
        process.exit(0);
    }

} catch (e) {
    console.error("❌ Failed to get git diff for last two commits:", e.message);
    process.exit(1);
}

// === PROMPT === //
// Modify the prompt to reflect that it's reviewing two commits
const prompt = `
You are an expert software engineer and code reviewer specializing in clean code, security, performance, and maintainability.
You are performing a code review for the **last two commits**. Pay attention to the individual changes within each commit context.

Here are the details of the commits being reviewed:
${commitDetails.map(c => `- Commit: ${c.hash}, Author: ${c.author}, Subject: "${c.subject}" (${c.isLatest ? 'Latest' : 'Second-to-Last'})`).join('\n')}

Please review the following code diff, which includes changes from these two commits, and respond in **strict JSON format**.

Your JSON output must follow this structure:

{
    "overall_summary": "Brief summary of the changes across both commits and your general impression.",
    "positive_aspects": ["List of good practices observed in these commits."],
    "issues": [
        {
            "severity": "[INFO|MINOR|MAJOR|CRITICAL]",
            "title": "Short title or label of the issue",
            "description": "Detailed explanation of the issue or concern.",
            "suggestion": "Proposed fix or recommendation.",
            "file": "Relative path to file (e.g., .github/scripts/ai-review.js)",
            "line": "Line number(s) where the issue occurs",
            "code_snippet": "Relevant snippet of the affected code",
            "commit_hash_related": "The hash of the commit this issue primarily relates to (e.g., ${commitDetails[0] ? commitDetails[0].hash : ''})" // New field
        }
    ]
}

Respond with only a single valid JSON object. No Markdown, headers, or commentary.

Here is the code diff for the last two commits:
\`\`\`diff
${diff}
\`\`\`
`;

// === AI Clients === //
// (No changes needed in AI client functions themselves)
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

    if (snippetLines.length === 0) return null;

    for (let i = 0; i <= lines.length - snippetLines.length; i++) {
        let matched = true;
        for (let j = 0; j < snippetLines.length; j++) {
            // Trim both original line and snippet line for robust matching
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

        if (!prNumber) {
            console.warn("Could not determine PR number from GITHUB_REF. This might not be a PR context. Skipping PR comment.");
            return;
        }

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

        let parsed;
        try {
            parsed = JSON.parse(review);
        } catch (err) {
            console.error("❌ Failed to parse AI response as JSON. Posting raw review.");
            await postCommentToGitHubPR(review);
            return;
        }

        // Add commit_hash_related to parsed issues for better context in output file
        for (const issue of parsed.issues || []) {
            const filePath = path.resolve(process.cwd(), issue.file);
            const result = matchSnippetInFile(filePath, issue.code_snippet);
            if (result) {
                issue.matched_line_range = `${result.start}-${result.end}`;
                console.log(`✅ Matched "${issue.title}" at ${issue.file}:${issue.matched_line_range}`);
            } else {
                issue.matched_line_range = null;
                console.warn(`❌ Could not match snippet for "${issue.title}" in ${issue.file}`);
            }
            // Ensure commit_hash_related is present, even if empty
            issue.commit_hash_related = issue.commit_hash_related || '';
        }

        fs.writeFileSync('review_with_line_matches.json', JSON.stringify(parsed, null, 2));
        console.log("📝 Saved review_with_line_matches.json");

        // Post to PR
        await postCommentToGitHubPR('```json\n' + JSON.stringify(parsed, null, 2) + '\n```');

    } catch (err) {
        console.error("❌ Error during AI review:", err.response?.data || err.message);
    }
}

reviewCode();