// Case 4: a mission is itself a batch of two missions, and the delivery is the Maket one.
module topology (input wire clk, input wire start, output wire delivered, output wire escalation_seen, output wire decision_seen, output wire validation_request_seen, output wire validation_seen);
  uwire escalation, arbitration, decision, vr, validation;
  assign escalation_seen = escalation; assign decision_seen = decision; assign validation_request_seen = vr; assign validation_seen = validation;
  assign vr = 0; assign validation = 0;
  uwire req_a, end_a, o_a, k_a;
  batch #(.ID("pdf-export"), .ASSIGNEE_1("agent-1"), .ASSIGNEE_2("agent-3"), .REVIEWER("agent-2"),
          .CRITERIA_1("PDF-100.AC1"), .CRITERIA_2("PDF-100.AC2"))
    a (.clk(clk), .start(start), .decision(decision), .request(req_a), .complete(end_a), .busy(o_a), .covers(k_a));
  coverage #(.N(2), .NAMES("PDF-100.AC1 PDF-100.AC2")) k (.criteria({k_a, k_a}));
  coordinator c (.clk(clk), .request(req_a), .arbitration(arbitration), .escalation(escalation), .decision(decision));
  owner p (.clk(clk), .escalation(escalation), .validation_request(1'b0), .arbitration(arbitration), .validation());
  delivery #(.PROCEDURE("maket-commit@1.0.0"), .INPUT("commit=4a78d7c")) l (.clk(clk), .all_complete(end_a), .delivered(delivered));
endmodule
