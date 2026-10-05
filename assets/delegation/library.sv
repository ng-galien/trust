// Delegation library: each element stands for one delegation capability of TRUST.
// Elements print one field per line, "<KIND> <instance path> <key> <value up to the end of the line>":
// declarations at time zero (MISSION, DECISION, DELIVERY, COVERAGE), then the events of the run (START, COMPLETE,
// DELIVERED, with key "time"). A refused run prints "REFUSED <instance path> reason <message>" and stops.
// scripts/delegation-topology.mjs parses these lines and builds the declarations; no element writes JSON.

// A text parameter holds no control character, so each field stays on its own line.
function automatic integer plain_text(input [8*1024-1:0] text);
  integer i;
  plain_text = 1;
  for (i = 0; i < 1024; i = i + 1)
    if (text[8*i +: 8] != 0 && (text[8*i +: 8] < 32 || text[8*i +: 8] == 127)) plain_text = 0;
endfunction

// A code mission: it may stop on an out-of-scope decision and wait for the arbitration.
module mission #(parameter ID = "", parameter PROCEDURE = "delegation-code@2.0.0",
                 parameter ASSIGNEE = "", parameter REVIEWER = "", parameter CRITERIA = "",
                 parameter BATCH = "", parameter DURATION = 6, parameter OUT_OF_SCOPE = 0) (
  input wire clk, input wire start, input wire decision,
  output reg request, output reg complete, output wire busy, output wire covers);
  generate
    if (ASSIGNEE == REVIEWER) $error({"mission ", ID, ": the reviewer is also the assignee"});
    if (ID == "") $error("mission: the id is empty");
    if (ASSIGNEE == "") $error({"mission ", ID, ": the assignee is empty"});
    if (REVIEWER == "") $error({"mission ", ID, ": the reviewer is empty"});
    if (!plain_text(ID) || !plain_text(PROCEDURE) || !plain_text(ASSIGNEE) || !plain_text(REVIEWER) ||
        !plain_text(CRITERIA) || !plain_text(BATCH))
      $error({"mission ", ID, ": a parameter holds a control character"});
  endgenerate
  initial begin
    $display("MISSION %m id %0s", ID);
    $display("MISSION %m procedure %0s", PROCEDURE);
    $display("MISSION %m assignee %0s", ASSIGNEE);
    $display("MISSION %m reviewer %0s", REVIEWER);
    $display("MISSION %m criteria %0s", CRITERIA);
    $display("MISSION %m batch %0s", BATCH);
    $display("MISSION %m kind mission");
  end
  initial begin request = 0; complete = 0; end
  integer done = 0; reg started = 0, suspended = 0;
  assign busy = started && !complete && !suspended;
  assign covers = 1;
  always @(posedge clk) begin
    request <= 0;
    if (start && !started) begin started <= 1; $display("START %m time %0d", $time / 2); end
    if (started && !complete && !suspended) begin
      if (OUT_OF_SCOPE && done == 2) begin request <= 1; suspended <= 1; done <= done + 1; end
      else if (done >= DURATION) begin complete <= 1; $display("COMPLETE %m time %0d", $time / 2); end
      else done <= done + 1;
    end
    if (suspended && decision) suspended <= 0;
  end
endmodule

// An interface mission: it completes only after the owner's visual validation, an owner decision by construction.
module mission_interface #(parameter ID = "", parameter PROCEDURE = "delegation-interface@3.0.0",
                           parameter ASSIGNEE = "", parameter REVIEWER = "", parameter CRITERIA = "",
                           parameter DURATION = 6) (
  input wire clk, input wire start, input wire validation,
  output reg validation_request, output reg complete, output wire busy, output wire covers);
  generate
    if (ASSIGNEE == REVIEWER) $error({"mission ", ID, ": the reviewer is also the assignee"});
    if (ID == "") $error("mission: the id is empty");
    if (ASSIGNEE == "") $error({"mission ", ID, ": the assignee is empty"});
    if (REVIEWER == "") $error({"mission ", ID, ": the reviewer is empty"});
    if (!plain_text(ID) || !plain_text(PROCEDURE) || !plain_text(ASSIGNEE) || !plain_text(REVIEWER) ||
        !plain_text(CRITERIA))
      $error({"mission ", ID, ": a parameter holds a control character"});
  endgenerate
  initial begin
    $display("MISSION %m id %0s", ID);
    $display("MISSION %m procedure %0s", PROCEDURE);
    $display("MISSION %m assignee %0s", ASSIGNEE);
    $display("MISSION %m reviewer %0s", REVIEWER);
    $display("MISSION %m criteria %0s", CRITERIA);
    $display("MISSION %m batch ");
    $display("MISSION %m kind interface");
    $display("DECISION %m owner visual validation");
  end
  initial begin validation_request = 0; complete = 0; end
  integer done = 0; reg started = 0, waiting = 0;
  assign busy = started && !complete && !waiting;
  assign covers = 1;
  always @(posedge clk) begin
    validation_request <= 0;
    if (start && !started) begin started <= 1; $display("START %m time %0d", $time / 2); end
    if (started && !complete && !waiting) begin
      if (done >= DURATION) begin waiting <= 1; validation_request <= 1; end else done <= done + 1;
    end
    if (waiting && validation && !complete) begin complete <= 1; $display("COMPLETE %m time %0d", $time / 2); end
  end
endmodule

// A batch: one delegated unit that holds two missions, one after the other (nested delegation).
module batch #(parameter ID = "", parameter PROCEDURE = "delegation-code@2.0.0",
               parameter ASSIGNEE_1 = "", parameter ASSIGNEE_2 = "", parameter REVIEWER = "",
               parameter CRITERIA_1 = "", parameter CRITERIA_2 = "") (
  input wire clk, input wire start, input wire decision,
  output wire request, output wire complete, output wire busy, output wire covers);
  generate if (ID == "") $error("batch: the id is empty"); endgenerate
  wire d1, d2, f1, o1, o2, c1, c2;
  mission #(.ID({ID, "-1"}), .PROCEDURE(PROCEDURE), .ASSIGNEE(ASSIGNEE_1), .REVIEWER(REVIEWER), .CRITERIA(CRITERIA_1),
            .BATCH(ID))
    m1 (.clk(clk), .start(start), .decision(decision), .request(d1), .complete(f1), .busy(o1), .covers(c1));
  mission #(.ID({ID, "-2"}), .PROCEDURE(PROCEDURE), .ASSIGNEE(ASSIGNEE_2), .REVIEWER(REVIEWER), .CRITERIA(CRITERIA_2),
            .BATCH(ID))
    m2 (.clk(clk), .start(f1), .decision(decision), .request(d2), .complete(complete), .busy(o2), .covers(c2));
  assign request = d1 | d2;
  assign busy = o1 | o2;
  assign covers = c1 & c2;
endmodule

// An analysis: a mission that returns findings. It holds no resource, so it has no busy output. It has no default
// Procedure: the topology names the one it uses.
module analysis #(parameter ID = "", parameter PROCEDURE = "",
                  parameter ASSIGNEE = "", parameter REVIEWER = "", parameter CRITERIA = "", parameter DURATION = 6) (
  input wire clk, input wire start, input wire decision,
  output reg request, output reg complete, output wire covers);
  generate
    if (ASSIGNEE == REVIEWER) $error({"analysis ", ID, ": the reviewer is also the assignee"});
    if (ID == "") $error("analysis: the id is empty");
    if (ASSIGNEE == "") $error({"analysis ", ID, ": the assignee is empty"});
    if (REVIEWER == "") $error({"analysis ", ID, ": the reviewer is empty"});
    if (PROCEDURE == "") $error({"analysis ", ID, ": the procedure is empty; a topology names the Procedure of each analysis"});
    if (!plain_text(ID) || !plain_text(PROCEDURE) || !plain_text(ASSIGNEE) || !plain_text(REVIEWER) ||
        !plain_text(CRITERIA))
      $error({"analysis ", ID, ": a parameter holds a control character"});
  endgenerate
  initial begin
    $display("MISSION %m id %0s", ID);
    $display("MISSION %m procedure %0s", PROCEDURE);
    $display("MISSION %m assignee %0s", ASSIGNEE);
    $display("MISSION %m reviewer %0s", REVIEWER);
    $display("MISSION %m criteria %0s", CRITERIA);
    $display("MISSION %m batch ");
    $display("MISSION %m kind analysis");
  end
  initial begin request = 0; complete = 0; end
  integer done = 0; reg started = 0;
  assign covers = 1;
  always @(posedge clk) begin
    if (start && !started) begin started <= 1; $display("START %m time %0d", $time / 2); end
    if (started && !complete) begin
      if (done >= DURATION) begin complete <= 1; $display("COMPLETE %m time %0d", $time / 2); end
      else done <= done + 1;
    end
    // decision is wired like a mission's; an analysis raises no out-of-scope question in the simulation.
    if (decision) request <= 0;
  end
endmodule

// A consolidation: complete once each of the N missions it receives has completed (each completion is latched).
module consolidation #(parameter N = 2) (input wire clk, input wire [N-1:0] complete_in, output reg complete);
  reg [N-1:0] seen = 0;
  initial complete = 0;
  always @(posedge clk) begin
    seen <= seen | complete_in;
    if (&(seen | complete_in)) complete <= 1;
  end
endmodule

// A resource that two missions never hold at the same time (the same files, for example).
module resource #(parameter NAME = "") (input wire clk, input wire busy_1, input wire busy_2);
  always @(posedge clk) if (busy_1 && busy_2) begin
    $display("REFUSED %m reason two missions work at the same time on the resource %0s (t=%0d)", NAME, $time / 2);
    $fatal(1);
  end
endmodule

// Coverage: the criteria of the thread. Each one is carried by a mission; NAMES lists them, space-separated.
module coverage #(parameter N = 1, parameter NAMES = "") (input wire [N-1:0] criteria);
  generate if (!plain_text(NAMES)) $error("coverage: NAMES holds a control character"); endgenerate
  initial begin
    $display("COVERAGE %m count %0d", N);
    $display("COVERAGE %m names %0s", NAMES);
  end
  integer i;
  initial begin
    #1;
    for (i = 0; i < N; i = i + 1) if (criteria[i] !== 1'b1) begin
      $display("REFUSED %m reason no mission carries criterion number %0d of [%0s] (t=0)", i + 1, NAMES);
      $fatal(1);
    end
  end
endmodule

// The owner: answers an escalation with an arbitration and a validation request with a validation.
module owner #(parameter LATENCY = 3) (
  input wire clk, input wire escalation, input wire validation_request,
  output reg arbitration, output reg validation);
  initial begin arbitration = 0; validation = 0; end
  integer a = 0, v = 0;
  always @(posedge clk) begin
    arbitration <= 0; validation <= 0;
    if (escalation && a == 0) a <= LATENCY;
    else if (a == 1) begin arbitration <= 1; a <= 0; end
    else if (a != 0) a <= a - 1;
    if (validation_request && v == 0) v <= LATENCY;
    else if (v == 1) begin validation <= 1; v <= 0; end
    else if (v != 0) v <= v - 1;
  end
endmodule

// The coordinator: escalates a mission's question to the owner and passes the arbitration back.
module coordinator (input wire clk, input wire request, input wire arbitration, output reg escalation, output reg decision);
  initial begin escalation = 0; decision = 0; end
  always @(posedge clk) begin escalation <= request; decision <= arbitration; end
endmodule

// The delivery: declared once all the missions are complete. INPUT holds space-separated key=value pairs.
module delivery #(parameter ID = "delivery", parameter PROCEDURE = "delivery-git@1.0.0", parameter INPUT = "") (
  input wire clk, input wire all_complete, output reg delivered);
  generate
    if (!plain_text(ID) || !plain_text(PROCEDURE) || !plain_text(INPUT))
      $error({"delivery ", ID, ": a parameter holds a control character"});
  endgenerate
  initial begin
    $display("DELIVERY %m id %0s", ID);
    $display("DELIVERY %m procedure %0s", PROCEDURE);
    $display("DELIVERY %m input %0s", INPUT);
  end
  initial delivered = 0;
  always @(posedge clk) if (all_complete && !delivered) begin
    delivered <= 1;
    $display("DELIVERED %m time %0d", $time / 2);
  end
endmodule
