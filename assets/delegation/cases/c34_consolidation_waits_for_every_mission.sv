// Case 34: an analysis that never starts keeps the consolidation incomplete, so the code mission never starts.
// The consolidation completes only when each mission it receives is complete.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire req_1, req_2, req_3, req_m, end_1, end_2, end_3, all_found, end_m, o_m, k_1, k_2, k_3, k_m;
  analysis #(.ID("survey-ui"), .PROCEDURE("delegation-code@2.0.0"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("ANA-1.AC1"), .DURATION(3))
    a1 (.clk(clk), .start(start), .decision(decision), .request(req_1), .complete(end_1), .covers(k_1));
  analysis #(.ID("survey-runtime"), .PROCEDURE("delegation-code@2.0.0"), .ASSIGNEE("agent-3"), .REVIEWER("agent-2"), .CRITERIA("ANA-1.AC2"), .DURATION(6))
    a2 (.clk(clk), .start(start), .decision(decision), .request(req_2), .complete(end_2), .covers(k_2));
  analysis #(.ID("survey-store"), .PROCEDURE("delegation-code@2.0.0"), .ASSIGNEE("agent-4"), .REVIEWER("agent-2"), .CRITERIA("ANA-1.AC3"), .DURATION(9))
    a3 (.clk(clk), .start(1'b0), .decision(decision), .request(req_3), .complete(end_3), .covers(k_3));
  consolidation #(.N(3)) f (.clk(clk), .complete_in({end_3, end_2, end_1}), .complete(all_found));
  mission #(.ID("apply-findings"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("ANA-1.AC4"))
    m (.clk(clk), .start(all_found), .decision(decision), .request(req_m), .complete(end_m), .busy(o_m), .covers(k_m));
  coverage #(.N(4), .NAMES("ANA-1.AC1 ANA-1.AC2 ANA-1.AC3 ANA-1.AC4")) k (.criteria({k_m, k_3, k_2, k_1}));
  coordinator c (.clk(clk), .request(req_1 | req_2 | req_3 | req_m), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(end_m), .delivered(delivered));
endmodule
