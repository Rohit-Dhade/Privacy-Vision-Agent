import { execSync } from "child_process";

const testFiles = [
  "privacy_security_hardening_tests.js",
  "web_content_prompt_injection_tests.js",
  "visual_dom_fusion_tests.js",
  "consequential_safety_tests.js",
  "generalized_hitl_tests.js",
  "task_memory_tests.js",
  "state_machine_tests.js",
  "agent_recovery_replanning_tests.js",
  "correctness_reliability_tests.js",
  "functional_correctness_tests.js",
  "general_task_planning_tests.js",
  "semantic_context_tests.js",
  "action_protocol_tests.js",
  "request_schema_contract_tests.js",
  "general_browser_agent_evaluation_suite.js",
  "e2e_general_agent_validation.js",
  "final_demo_smoke_test.js",
  "provider_switch_tests.js",
  "semantic_dom_shadow_tests.js",
  "real_world_shadow_evaluation.js",
  "unsupported_initial_page_tests.js",
  "vlm_context_budget_tests.js"
];

console.log("================================================================================");
console.log("                   PHASE 1: REGRESSION SUITE EXECUTION REPORT                   ");
console.log("================================================================================\n");

let totalSuites = testFiles.length;
let passedSuites = 0;
let failedSuites = 0;

for (const file of testFiles) {
  try {
    const output = execSync(`node test/${file}`, { cwd: process.cwd(), encoding: "utf8" });
    passedSuites++;
    console.log(`[PASS] Suite: ${file}`);
    const summaryLines = output.split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("TEST RESULTS:") || l.startsWith("TOTAL CATEGORIES") || l.startsWith("TOTAL ACTIONS") || l.includes("ALL CONTRACT"));
    if (summaryLines.length > 0) {
      summaryLines.forEach(l => console.log(`       ${l}`));
    } else {
      console.log(`       Completed successfully.`);
    }
  } catch (err) {
    failedSuites++;
    console.log(`[FAIL] Suite: ${file}`);
    console.log(err.stdout || err.message);
  }
}

console.log("\n================================================================================");
console.log(`SUITE SUMMARY: ${passedSuites}/${totalSuites} Suites Passed (Failed: ${failedSuites})`);
console.log("================================================================================");
