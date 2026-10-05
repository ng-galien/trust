// Case 37: the validation of the interface mission is an expression over the owner's validation.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  uwire req_a, end_a, end_b, o_a, o_b, k_a, k_b;
  mission #(.ID("declared-delivery"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("ORG-130.AC1 ORG-130.AC2"), .OUT_OF_SCOPE(1))
    a (.clk(clk), .start(start), .decision(decision), .request(req_a), .complete(end_a), .busy(o_a), .covers(k_a));
  mission_interface #(.ID("plan-card"), .ASSIGNEE("agent-2"), .REVIEWER("agent-1"), .CRITERIA("CXP-250.AC1"))
    b (.clk(clk), .start(start), .validation(validation | end_a), .validation_request(vr), .complete(end_b), .busy(o_b), .covers(k_b));
  coverage #(.N(3), .NAMES("ORG-130.AC1 ORG-130.AC2 CXP-250.AC1")) k (.criteria({k_b, k_a, k_a}));
  coordinator c (.clk(clk), .request(req_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(vr), .arbitration(arbitration), .validation(validation));
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(end_a & end_b), .delivered(delivered));
endmodule
