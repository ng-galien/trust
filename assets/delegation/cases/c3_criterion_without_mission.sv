// Case 3: the thread has three criteria, the missions carry only two.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire req_a, end_a, o_a, k_a, k_3;
  mission #(.ID("thread-states"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("CXP-330.AC1 CXP-330.AC2"))
    a (.clk(clk), .start(start), .decision(decision), .request(req_a), .complete(end_a), .busy(o_a), .covers(k_a));
  coverage #(.N(3), .NAMES("CXP-330.AC1 CXP-330.AC2 CXP-340.AC1")) k (.criteria({k_3, k_a, k_a}));
  coordinator c (.clk(clk), .request(req_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(end_a), .delivered(delivered));
endmodule
