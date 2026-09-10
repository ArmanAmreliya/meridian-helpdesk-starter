# AI Disclosure Log — Bilions Practical Exercise

**Author:** Arman Amreliya  
**Context:** Deliverable 4 — AI Assistant Usage & Disclosure Log  

---

### 1. Assistants Used
- **Google Antigravity IDE Agent** (incorporating Claude 3.7 Sonnet and Gemini 2.5 Flash for agentic reasoning, code analysis, and terminal orchestration).

---

### 2. Summary of Inquiries & Workflow
- **Part 1 Codebase Review:** Guided code exploration across `server/` and `client/` to identify security vulnerabilities, role authorization gaps, pagination bugs, and multi-tenant data leaks.
- **Part 2 SLA Feature Design:** Queried for architectural patterns to compute first-response SLA milestones within the existing Express/MySQL/React architecture without introducing an external ORM or state management libraries.
- **Automated Verification:** Generated test scripts to simulate authenticated requests across different tenant roles and edge cases.

---

### 3. Misleading Outputs & Errors Caught

A log with no errors is not credible; below are the four notable instances where the assistant’s output was incorrect, incomplete, or misleading, and how each was caught and resolved:

#### A. Naive Definition of "Response" (Premature SLA Fulfillment)
- **What the AI proposed:** The assistant initially proposed calculating response time using `SELECT MIN(created_at) FROM comments WHERE ticket_id = t.id`.
- **Why it was wrong:** It treated *any* comment as satisfying the SLA. In real helpdesk workflows (and in this seed data), customers often post follow-up comments or screenshots immediately after raising a ticket. Under the AI's proposal, customer comments would falsely mark an unanswered ticket as compliant.
- **How it was caught & fixed:** During code review of the proposed query, I recognized that only support personnel can satisfy a response target. I updated the query to require `JOIN users u ON u.id = c.author_id WHERE u.role IN ('agent', 'admin') AND c.is_internal = 0`.

#### B. Timezone Skew via Mixed JavaScript/MySQL Date Arithmetic
- **What the AI proposed:** The assistant initially suggested calculating breach elapsed hours in JavaScript using `Date.now() - new Date(ticket.created_at).getTime()`.
- **Why it was wrong:** As identified during the Part 1 review (Finding 12), the Docker MySQL container runs under `Asia/Kolkata (+05:30)` while Node's `new Date()` parses timestamps into UTC. Comparing JavaScript UTC timestamps against local MySQL timestamps introduced an artificial 5.5-hour skew, causing tickets to report false-positive breaches immediately after creation.
- **How it was caught & fixed:** Verified against database rows and moved the entire date interval calculation into MySQL using `DATE_ADD(t.created_at, INTERVAL ... HOUR)` and native `NOW()`, ensuring zero timezone mismatch.

#### C. SQL Subquery Missing from Pagination Count Query
- **What the AI proposed:** When adding the `breached=true` filter, the AI appended `where.push('resp.first_response_at > ...')` to the shared `whereSql` string, but initially only included the `FIRST_RESPONSE_SUBQUERY` join in the `SELECT ... FROM tickets` statement and omitted it from the `SELECT COUNT(*) AS total FROM tickets` statement.
- **Why it was wrong:** Executing the count query threw an immediate runtime MySQL error: `Error: Unknown column 'resp.first_response_at' in 'where clause'`.
- **How it was caught & fixed:** Caught immediately during automated script verification. I ensured `FIRST_RESPONSE_SUBQUERY` was joined in both the row selection and the pagination count queries.

#### D. PowerShell Statement Separator Syntax
- **What the AI proposed:** Suggested combined command chains using Bash syntax: `git add . && git commit -m "..."`.
- **Why it was wrong:** Windows PowerShell 5.1 rejects `&&` as an invalid statement separator (`The token '&&' is not a valid statement separator in this version`).
- **How it was caught & fixed:** The command errored in the terminal; corrected to PowerShell's statement separator `;`.
