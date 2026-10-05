// Case 15: a code mission, then an interface mission, both on the test Procedure topology-work; the delivery runs
// topology-delivery. Its data file c15_declared_procedures.missions.json gives the other root inputs.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  uwire req_a, end_a, end_b, o_a, o_b, k_a, k_b;
  mission #(.ID("model"), .PROCEDURE("topology-work@1.0.0"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("TOPO-T.AC1"))
    a (.clk(clk), .start(start), .decision(decision), .request(req_a), .complete(end_a), .busy(o_a), .covers(k_a));
  mission_interface #(.ID("screen"), .PROCEDURE("topology-work@1.0.0"), .ASSIGNEE("agent-2"), .REVIEWER("agent-1"), .CRITERIA("TOPO-T.AC2"))
    b (.clk(clk), .start(end_a), .validation(validation), .validation_request(vr), .complete(end_b), .busy(o_b), .covers(k_b));
  coverage #(.N(2), .NAMES("TOPO-T.AC1 TOPO-T.AC2")) k (.criteria({k_b, k_a}));
  coordinator c (.clk(clk), .request(req_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(vr), .arbitration(arbitration), .validation(validation));
  delivery #(.ID("release"), .PROCEDURE("topology-delivery@1.0.0"), .INPUT("project=trust")) l (.clk(clk), .all_complete(end_a & end_b), .delivered(delivered));
endmodule
