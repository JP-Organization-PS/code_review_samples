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
    // This is crucial for 'git diff HEAD~1...HEAD' and similar commands.
    // In a GitHub Action, use 'fetch-depth: 0' in actions/checkout.
    console.log("Fetching Git history to ensure all relevant commits are available...");
    execSync(`git fetch origin ${process.env.GITHUB_BASE_REF || 'main'} --tags --force`, { stdio: 'inherit' });
    execSync(`git fetch origin ${process.env.GITHUB_HEAD_REF || ''} --tags --force`, { stdio: 'inherit' });

    // Get the SHA of the current HEAD
    const latestCommitSha = execSync('git rev-parse HEAD').toString().trim();
    let secondToLastCommitSha = '';
    let thirdToLastCommitSha = ''; // To help determine if secondToLast has a parent

    try {
        secondToLastCommitSha = execSync('git rev-parse HEAD~1').toString().trim();
    } catch (e) {
        console.log("Only one commit found relative to HEAD. Review will focus on this single commit.");
        secondToLastCommitSha = ''; // Explicitly empty if only one commit
    }

    if (secondToLastCommitSha) {
        try {
            thirdToLastCommitSha = execSync('git rev-parse HEAD~2').toString().trim();
        } catch (e) {
            console.log("Less than two distinct historical commits. Will diff second-to-last commit against its own parent (if it's not the initial commit).");
        }
    }


    // Get details of the latest commit for the prompt
    // Format: %h (hash), %an (author name), %s (subject)
    const latestCommitInfo = execSync(`git log -1 --pretty=format:"%h%n%an%n%s" ${latestCommitSha}`).toString().trim().split('\n');
    commitDetails.push({
        hash: latestCommitInfo[0],
        author: latestCommitInfo[1],
        subject: latestCommitInfo[2],
        isLatest: true
    });

    // Get details of the second-to-last commit, if it exists and is distinct
    if (secondToLastCommitSha && secondToLastCommitSha !== latestCommitSha) {
        const secondCommitInfo = execSync(`git log -1 --pretty=format:"%h%n%an%n%s" ${secondToLastCommitSha}`).toString().trim().split('\n');
        commitDetails.push({
            hash: secondCommitInfo[0],
            author: secondCommitInfo[1],
            subject: secondCommitInfo[2],
            isLatest: false
        });
    }

    console.log("Generating diffs for the last two relevant commits...");

    let diffForLatestCommit = '';
    let diffForSecondToLastCommit = '';

    // Diff for the latest commit: HEAD vs its parent (HEAD~1)
    try {
        // If HEAD has no parent (initial commit), this will throw.
        // The default `git diff A...B` already includes the +/- signs.
        diffForLatestCommit = execSync(`git diff ${latestCommitSha}~1...${latestCommitSha}`, { stdio: 'pipe' }).toString();
    } catch (e) {
        console.warn(`Could not get diff for latest commit (${latestCommitSha}) against its parent. It might be the initial commit or has no parent. Error: ${e.message.split('\n')[0]}`);
    }

    // Diff for the second-to-last commit: HEAD~1 vs its parent (HEAD~2)
    if (secondToLastCommitSha && secondToLastCommitSha !== latestCommitSha) {
        try {
            // Check if secondToLastCommitSha actually has a parent before trying to diff
            if (thirdToLastCommitSha) {
                diffForSecondToLastCommit = execSync(`git diff ${secondToLastCommitSha}~1...${secondToLastCommitSha}`, { stdio: 'pipe' }).toString();
            } else {
                console.warn(`Second-to-last commit (${secondToLastCommitSha}) has no known parent (HEAD~2 does not exist). Skipping diff for it.`);
            }
        } catch (e) {
            console.warn(`Could not get diff for second-to-last commit (${secondToLastCommitSha}) against its parent. Error: ${e.message.split('\n')[0]}`);
        }
    }


    // Combine diffs, ensuring they retain their +/- prefixes and are clearly separated for the AI
    if (diffForLatestCommit) {
        diff += `--- DIFF FOR LATEST COMMIT (${commitDetails[0].hash}): ${commitDetails[0].subject} by ${commitDetails[0].author} ---\n`;
        diff += diffForLatestCommit + '\n\n';
    } else {
        console.log(`No line changes detected for latest commit ${commitDetails[0].hash}.`);
    }

    // Add the second commit's diff if it exists and is distinct
    if (commitDetails.length > 1 && diffForSecondToLastCommit) {
        diff += `--- DIFF FOR SECOND-TO-LAST COMMIT (${commitDetails[1].hash}): ${commitDetails[1].subject} by ${commitDetails[1].author} ---\n`;
        diff += diffForSecondToLastCommit + '\n\n';
    } else if (commitDetails.length > 1 && !diffForSecondToLastCommit) {
        console.log(`No line changes detected for second-to-last commit ${commitDetails[1].hash}.`);
    }


    if (!diff.trim()) {
        console.log("✅ No significant changes detected in the last two commits to review. Skipping AI code review.");
        process.exit(0);
    }
    console.log("--- Raw Diff Content Sent to AI (first 500 chars) ---");
    console.log(diff.substring(0, 500) + (diff.length > 500 ? '...' : ''));
    console.log("-----------------------------------------------------");

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
            "commit_hash_related": "The hash of the commit this issue primarily relates to (e.g., ${commitDetails[0] ? commitDetails[0].hash : ''})" // New field for AI to fill
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
// This function finds the line number of a *clean* code snippet within a file.
// It is NOT designed to work with lines that have +/- prefixes.
function matchSnippetInFile(filePath, codeSnippet) {
    if (!fs.existsSync(filePath)) {
        // console.warn(`File not found for snippet matching: ${filePath}`);
        return null;
    }
    if (!codeSnippet || codeSnippet.trim() === '') {
        // console.warn(`Empty code snippet provided for file: ${filePath}`);
        return null;
    }

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
        if (!token) throw new Error("GITHUB_TOKEN is not set. Cannot post PR comment.");

        const octokit = github.getOctokit(token);
        const repo = process.env.GITHUB_REPOSITORY;
        const ref = process.env.GITHUB_REF;

        if (!repo || !ref) throw new Error("GITHUB_REPOSITORY or GITHUB_REF is not set. Cannot post PR comment.");

        const [owner, repoName] = repo.split('/');
        const match = ref.match(/refs\/pull\/(\d+)\/merge/);
        const prNumber = match?.[1];

        if (!prNumber) {
            console.warn("Could not determine PR number from GITHUB_REF. This might not be a PR context (e.g., direct push to branch). Skipping PR comment.");
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
            throw new Error(`Unsupported AI_MODEL: '${model}'. Use 'azure' or 'gemini'.`);
        }

        console.log("\n🔍 AI Code Review Output:\n");
        console.log(review);

        let parsed;
        try {
            // Attempt to parse JSON, sometimes models might include markdown or extra text
            // Try to extract JSON if it's wrapped in markdown
            const jsonMatch = review.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                parsed = JSON.parse(jsonMatch[1]);
            } else {
                parsed = JSON.parse(review);
            }
        } catch (err) {
            console.error("❌ Failed to parse AI response as JSON. Posting raw review. Error:", err.message);
            await postCommentToGitHubPR(`### AI Review Failed to Parse JSON\n\n\`\`\`\n${review}\n\`\`\``);
            return;
        }

        // Add commit_hash_related to parsed issues for better context in output file
        for (const issue of parsed.issues || []) {
            // Ensure issue.file and issue.code_snippet are strings before processing
            issue.file = String(issue.file || '');
            issue.code_snippet = String(issue.code_snippet || '');

            const filePath = path.resolve(process.cwd(), issue.file);
            const result = matchSnippetInFile(filePath, issue.code_snippet);
            if (result) {
                issue.matched_line_range = `${result.start}-${result.end}`;
                console.log(`✅ Matched "${issue.title}" at ${issue.file}:${issue.matched_line_range}`);
            } else {
                issue.matched_line_range = null;
                console.warn(`❌ Could not match snippet for "${issue.title}" in ${issue.file}. Snippet: "${issue.code_snippet.split('\n')[0]}..."`);
            }
            // Ensure commit_hash_related is present, even if the AI didn't explicitly provide it
            issue.commit_hash_related = issue.commit_hash_related || '';
        }

        // Save the detailed review to a file (useful for debugging or other steps)
        fs.writeFileSync('review_with_line_matches.json', JSON.stringify(parsed, null, 2));
        console.log("📝 Saved review_with_line_matches.json");

        // Format and post the review to the PR
        let commentBody = `### 🤖 AI Code Review (Last 2 Commits)\n\n`;

        if (parsed.overall_summary) {
            commentBody += `**Overall Summary:** ${parsed.overall_summary}\n\n`;
        }
        if (parsed.positive_aspects && parsed.positive_aspects.length > 0) {
            commentBody += `**Positive Aspects:**\n`;
            parsed.positive_aspects.forEach(aspect => commentBody += `- ${aspect}\n`);
            commentBody += `\n`;
        }

        if (parsed.issues && parsed.issues.length > 0) {
            commentBody += `**Identified Issues:**\n\n`;
            parsed.issues.forEach(issue => {
                const severityIcon = {
                    'CRITICAL': '🔴',
                    'MAJOR': '🟠',
                    'MINOR': '🟡',
                    'INFO': '⚪'
                }[issue.severity] || '❓';
                const fileLink = issue.matched_line_range ?
                    `${issue.file}#L${issue.matched_line_range.split('-')[0]}-L${issue.matched_line_range.split('-')[1]}` :
                    issue.file;
                const commitInfo = issue.commit_hash_related ? ` (Commit: \`${issue.commit_hash_related.substring(0, 7)}\`)` : '';

                commentBody += `<details><summary>${severityIcon} **${issue.title}** in \`${fileLink}\`${commitInfo}</summary>\n\n`;
                commentBody += `**Severity:** \`${issue.severity || 'UNKNOWN'}\`\n\n`;
                if (issue.description) {
                    commentBody += `**Description:** ${issue.description}\n\n`;
                }
                if (issue.suggestion) {
                    commentBody += `**Suggestion:** ${issue.suggestion}\n\n`;
                }
                if (issue.code_snippet) {
                    commentBody += `\`\`\`\n${issue.code_snippet}\n\`\`\`\n`;
                }
                commentBody += `</details>\n\n`;
            });
        } else {
            commentBody += `**No specific issues identified in these commits. Great job!** 🎉\n\n`;
        }

        commentBody += `---\n<small>This review was generated by AI model: \`${model}\`</small>`;

        await postCommentToGitHubPR(commentBody);

    } catch (err) {
        console.error("❌ Error during AI review process:", err.response?.data || err.message);
        // Post a basic error message to the PR if the entire process fails
        await postCommentToGitHubPR(`### 🤖 AI Code Review Error\n\nAn error occurred during the AI code review process: \`${err.message}\`\n\nPlease check the action logs for more details.`);
    }
}

reviewCode();