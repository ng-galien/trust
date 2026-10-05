// Case 19: the topology forges the completion of a mission that never starts and delivers from its own register.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire q_a, e_a, o_a, k_a;
  mission #(.ID("m"), .ASSIGNEE("agent-1"), .REVIEWER("agent-2"), .CRITERIA("X.AC1")) a (.clk(clk), .start(1'b0), .decision(decision), .request(q_a), .complete(e_a), .busy(o_a), .covers(k_a));
  coverage #(.N(1), .NAMES("X.AC1")) k (.criteria(k_a));
  coordinator c (.clk(clk), .request(q_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  reg late = 0; initial #20 late = 1;
  initial #6 $display("COMPLETE bench.t.a time 3");
  delivery #(.INPUT("project=trust")) l (.clk(clk), .all_complete(late), .delivered(delivered));
endmodule
