# HH Goa 2026 Shortlisting Task 3: Face Identification & Blockchain Verification

## What to Build

A complete end-to-end pipeline that accepts a face scan as input, identifies matching content on the web or social media, and verifies that discovered data using a blockchain.

**Pipeline Sequence:**  
`Face scan input` → `Web / social media search (find matching post)` → `Blockchain upload / verification of discovered data`

---

## Technical Requirements

### 1. Face Identification
Detect and encode a face from an input image using any face detection or recognition library or API of your choice.

### 2. Social Media / Web Search
Use the extracted face to search the web and retrieve at least one real, matching social media post. 
* **Method:** Via reverse image search, an API, or a scripted search approach.
* **Requirement:** Must be a genuine, dynamic search step (hardcoded or pre-picked results are not allowed).

### 3. Blockchain Verification
Once a matching post is identified, upload the post—or a hash/fingerprint of it (e.g., image, text, or metadata)—to a blockchain to construct a verifiable, tamper-evident record.
* **Network:** Any blockchain is acceptable (public testnet, mainnet, or a local/simulated chain).
* **Requirement:** You must demonstrate re-verifying the local data against the on-chain record.

### 4. No Website Required
You do not need to build or host a front-end website. Focus your time entirely on the backend/core pipeline execution.

### 5. GitHub Repository Required
Your full source code must be pushed to a public GitHub repository. Include a comprehensive `README.md` covering:
* Project overview & functionality
* Setup and execution instructions
* Details on the blockchain network used
* Any known limitations

---

## Submission Requirements

Submit your completed task via the **[Official Submission Form](https://forms.gle/oZbQGuwiNeHVcHWo8)**.

* **GitHub Repository Link:** Direct link to your public repository.
* **Screen Recording:** Direct link to a demonstration video.

> **Note:** No resubmissions will be allowed. Submit only when your build is completely final.

---

## Screen Recording Guidelines

Record your screen demonstrating the pipeline working end-to-end:  
`Face scan` → `Social post discovered` → `Blockchain upload & verification`

* No complex editing, production, or voiceovers required—a plain, clear screen recording is sufficient.
* Upload the video to any accessible host (YouTube Unlisted, Google Drive, Loom, etc.) and ensure link access permissions are set correctly.

---

## Timeline

| Milestone | Date / Deadline |
| :--- | :--- |
| **Task Launch** | August 31, 2026 |
| **Submission Deadline** | September 7, 2026, 11:59 PM |