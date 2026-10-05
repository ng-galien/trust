// Case 43: the first mission has an empty reviewer.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire req_a, req_b, end_a, end_b, o_a, o_b, k_a, k_b;
  mission #(.ID("batch-b-card"), .ASSIGNEE("agent-1"), .REVIEWER(""), .CRITERIA("CXP-260.AC1"))
    a (.clk(clk), .start(start), .decision(decision), .request(req_a), .complete(end_a), .busy(o_a), .covers(k_a));
  mission #(.ID("batch-c-follow-up"), .ASSIGNEE("agent-3"), .REVIEWER("agent-2"), .CRITERIA("CXP-260.AC2"))
    b (.clk(clk), .start(end_a), .decision(decision), .request(req_b), .complete(end_b), .busy(o_b), .covers(k_b));
  resource #(.NAME("extensions/corpus/ui")) r (.clk(clk), .busy_1(o_a), .busy_2(o_b));
  coverage #(.N(2), .NAMES("CXP-260.AC1 CXP-260.AC2")) k (.criteria({k_b, k_a}));
  coordinator c (.clk(clk), .request(req_a | req_b), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(end_a & end_b), .delivered(delivered));
endmodule
