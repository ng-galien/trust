// Case 7: a mission raises an out-of-scope question, but the arbitration that answers it is wired to nobody.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire req_a, end_a, o_a, k_a;
  mission #(.ID("declared-delivery"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .OUT_OF_SCOPE(1))
    a (.clk(clk), .start(start), .decision(), .request(req_a), .complete(end_a), .busy(o_a), .covers(k_a));
  coordinator c (.clk(clk), .request(req_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(end_a), .delivered(delivered));
endmodule
