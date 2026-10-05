// Test bench: starts the topology, reports its events and refuses a work that is never delivered.
// Every line it prints follows the library's line protocol.
module bench;
  reg clk = 0;
  always #1 clk = ~clk;
  reg start = 0;
  wire delivered, escalation, decision, validation_request, validation;
  topology t (.clk(clk), .start(start), .delivered(delivered), .escalation_seen(escalation), .decision_seen(decision),
              .validation_request_seen(validation_request), .validation_seen(validation));
  always @(posedge escalation) $display("EVENT %m escalation %0d", $time / 2);
  always @(posedge decision) $display("EVENT %m arbitration %0d", $time / 2);
  always @(posedge validation_request) $display("EVENT %m validation_request %0d", $time / 2);
  always @(posedge validation) $display("EVENT %m validation %0d", $time / 2);
  initial begin
    #2 start = 1;
    #2 start = 0;
    #300;
    if (delivered !== 1'b1) begin
      $display("REFUSED %m reason the work is never delivered (t=%0d)", $time / 2);
      $fatal(1);
    end
    $finish(0);
  end
endmodule
