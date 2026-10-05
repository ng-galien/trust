// Case 24: an escaped identifier holding /* hides an element defined after the topology.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire q_a, e_a, o_a, k_a;
  mission #(.ID("m"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("X.AC1")) a (.clk(clk), .start(start), .decision(decision), .request(q_a), .complete(e_a), .busy(o_a), .covers(k_a));
  coverage #(.N(1), .NAMES("X.AC1")) k (.criteria(k_a));
  coordinator c (.clk(clk), .request(q_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(e_a), .delivered(delivered));
  uwire \h/*x ;
  reviewer_pool #(.SIZE(2)) r (.clk(clk));
endmodule
module reviewer_pool #(parameter SIZE = 1) (input wire clk); // */
endmodule
