package dev.trust.jiramock;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
class JiraMockController {
  private static final String ISSUE_PREFIX = "TK";
  private static final Pattern ISSUE_KEY_PATTERN = Pattern.compile("^(?:([A-Za-z]+)-?)?(\\d+)$");

  private final String baseUrl;
  private final JdbcTemplate jdbc;
  private final ObjectMapper objectMapper;

  JiraMockController(
      @Value("${jira-mock.base-url}") String baseUrl,
      JdbcTemplate jdbc,
      ObjectMapper objectMapper) {
    this.baseUrl = baseUrl.replaceAll("/$", "");
    this.jdbc = jdbc;
    this.objectMapper = objectMapper;
  }

  @PostConstruct
  void initializeDatabase() {
    jdbc.execute("""
        CREATE TABLE IF NOT EXISTS issues (
          issue_key TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL,
          assignee TEXT NOT NULL,
          priority TEXT NOT NULL,
          created TEXT NOT NULL
        )
        """);
    jdbc.execute("""
        CREATE TABLE IF NOT EXISTS comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          issue_key TEXT NOT NULL REFERENCES issues(issue_key) ON DELETE CASCADE,
          body_json TEXT NOT NULL,
          author TEXT NOT NULL,
          created TEXT NOT NULL
        )
        """);
    Integer issueCount = jdbc.queryForObject("SELECT COUNT(*) FROM issues", Integer.class);
    if (issueCount != null && issueCount == 0) {
      seedDefaultScenario();
    }
  }

  @GetMapping("/rest/api/2/myself")
  Map<String, Object> myself() {
    return Map.of(
        "accountId", "mock-user-account",
        "displayName", "Mock Trust User",
        "name", "mock-user",
        "emailAddress", "mock-user@example.test");
  }

  @GetMapping("/rest/agile/1.0/board/{boardId}/sprint")
  Map<String, Object> activeSprint(@PathVariable long boardId, @RequestParam Optional<String> state) {
    if (state.isPresent() && !"active".equals(state.get())) {
      return Map.of("maxResults", 50, "startAt", 0, "isLast", true, "values", List.of());
    }
    return Map.of(
        "maxResults", 50,
        "startAt", 0,
        "isLast", true,
        "values", List.of(Map.of(
            "id", 1,
            "self", "%s/rest/agile/1.0/trust/1".formatted(baseUrl),
            "state", "active",
            "name", "Trust Kind Test environment",
            "startDate", "2026-07-01T08:00:00.000Z",
            "endDate", "2026-07-15T17:00:00.000Z",
            "goal", "Exercise ticket resolution against local connectors")));
  }

  @GetMapping("/rest/agile/1.0/board/{boardId}/sprint/{sprintId}/issue")
  Map<String, Object> sprintIssues(@PathVariable long boardId, @PathVariable long sprintId) {
    List<Map<String, Object>> found = allIssues().stream()
        .sorted(Comparator.comparing(MutableIssue::key))
        .map(this::issuePayload)
        .toList();
    return Map.of("startAt", 0, "maxResults", 100, "total", found.size(), "issues", found);
  }

  @GetMapping("/rest/api/3/search/jql")
  Map<String, Object> searchJql(@RequestParam String jql) {
    String requestedKey = extractIssueKey(jql);
    List<Map<String, Object>> found = allIssues().stream()
        .filter(issue -> requestedKey == null || issue.key().equals(requestedKey))
        .sorted(Comparator.comparing(MutableIssue::key))
        .map(this::issuePayload)
        .toList();
    return Map.of("startAt", 0, "maxResults", 100, "total", found.size(), "issues", found);
  }

  private String extractIssueKey(String jql) {
    Matcher matcher = Pattern.compile("(?i)\\bkey\\s*=\\s*['\"]?([A-Z][A-Z0-9_]*-\\d+)['\"]?")
        .matcher(jql);
    return matcher.find() ? normalizeIssueKey(matcher.group(1)) : null;
  }

  @GetMapping("/rest/api/3/issue/{key}")
  Map<String, Object> getIssue(@PathVariable String key) {
    return issuePayload(requireIssue(key));
  }

  @PostMapping("/rest/api/3/issue")
  @ResponseStatus(HttpStatus.CREATED)
  Map<String, Object> createJiraIssue(@Valid @RequestBody IssueInput input) {
    String key = insertGeneratedIssue(input);
    return issuePayload(requireIssue(key));
  }

  @PutMapping("/rest/api/3/issue/{key}")
  Map<String, Object> updateJiraIssue(@PathVariable String key, @Valid @RequestBody IssueUpdateInput input) {
    String normalizedKey = normalizeIssueKey(key);
    updateIssue(normalizedKey, input);
    return issuePayload(requireIssue(normalizedKey));
  }

  @DeleteMapping("/rest/api/3/issue/{key}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  void deleteJiraIssue(@PathVariable String key) {
    deleteIssue(normalizeIssueKey(key));
  }

  @GetMapping("/rest/api/3/issue/{key}/comment")
  Map<String, Object> getComments(@PathVariable String key) {
    String normalizedKey = normalizeIssueKey(key);
    requireIssue(normalizedKey);
    List<Map<String, Object>> comments = commentsFor(normalizedKey).stream()
        .map(this::commentPayload)
        .toList();
    return Map.of("startAt", 0, "maxResults", 100, "total", comments.size(), "comments", comments);
  }

  @PostMapping("/rest/api/3/issue/{key}/comment")
  @ResponseStatus(HttpStatus.CREATED)
  Map<String, Object> addComment(@PathVariable String key, @Valid @RequestBody CommentInput input) {
    String normalizedKey = normalizeIssueKey(key);
    requireIssue(normalizedKey);
    String created = Instant.now().toString();
    KeyHolder keyHolder = new GeneratedKeyHolder();
    jdbc.update(connection -> {
      PreparedStatement statement = connection.prepareStatement(
          "INSERT INTO comments(issue_key, body_json, author, created) VALUES (?, ?, ?, ?)",
          Statement.RETURN_GENERATED_KEYS);
      statement.setString(1, normalizedKey);
      statement.setString(2, toJson(input.body()));
      statement.setString(3, "Mock Trust User");
      statement.setString(4, created);
      return statement;
    }, keyHolder);
    Number id = keyHolder.getKey();
    if (id == null) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Comment id was not generated");
    }
    return commentPayload(new MutableComment(id.longValue(), normalizedKey, toJson(input.body()), "Mock Trust User", created));
  }

  @GetMapping("/rest/api/3/issue/{key}/transitions")
  Map<String, Object> getTransitions(@PathVariable String key) {
    MutableIssue issue = requireIssue(key);
    return Map.of("transitions", transitionsFor(issue.status()).stream()
        .map(transition -> Map.of(
            "id", transition.id(),
            "name", transition.name(),
            "to", Map.of("name", transition.toStatus())))
        .toList());
  }

  @PostMapping("/rest/api/3/issue/{key}/transitions")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  void transitionIssue(@PathVariable String key, @Valid @RequestBody TransitionInput input) {
    String normalizedKey = normalizeIssueKey(key);
    MutableIssue issue = requireIssue(normalizedKey);
    Transition transition = transitionsFor(issue.status()).stream()
        .filter(candidate -> candidate.id().equals(input.transition().id()))
        .findFirst()
        .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Transition is not available"));
    jdbc.update("UPDATE issues SET status = ? WHERE issue_key = ?", transition.toStatus(), normalizedKey);
  }

  @PostMapping("/__admin/reset")
  @Transactional
  Map<String, Object> resetAdmin() {
    jdbc.update("DELETE FROM comments");
    jdbc.update("DELETE FROM issues");
    seedDefaultScenario();
    return scenario();
  }

  @GetMapping("/__admin/scenario")
  Map<String, Object> scenario() {
    return Map.of("issues", allIssues().stream()
        .sorted(Comparator.comparing(MutableIssue::key))
        .map(this::issuePayload)
        .toList());
  }

  @PutMapping("/__admin/scenario")
  @Transactional
  Map<String, Object> replaceScenario(@RequestBody ScenarioInput input) {
    jdbc.update("DELETE FROM comments");
    jdbc.update("DELETE FROM issues");
    for (IssueInput issue : input.issues()) {
      insertConfiguredIssue(issue);
    }
    return scenario();
  }

  @PostMapping("/__admin/issues")
  @ResponseStatus(HttpStatus.CREATED)
  Map<String, Object> createIssue(@Valid @RequestBody IssueInput input) {
    String key = insertGeneratedIssue(input);
    return issuePayload(requireIssue(key));
  }

  @PutMapping("/__admin/issues/{key}")
  Map<String, Object> updateAdminIssue(@PathVariable String key, @Valid @RequestBody IssueUpdateInput input) {
    String normalizedKey = normalizeIssueKey(key);
    updateIssue(normalizedKey, input);
    return issuePayload(requireIssue(normalizedKey));
  }

  @DeleteMapping("/__admin/issues/{key}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  void deleteAdminIssue(@PathVariable String key) {
    deleteIssue(normalizeIssueKey(key));
  }

  private List<MutableIssue> allIssues() {
    return jdbc.query(
        "SELECT issue_key, summary, description, status, assignee, priority, created FROM issues",
        (rs, rowNum) -> new MutableIssue(
            rs.getString("issue_key"),
            rs.getString("summary"),
            rs.getString("description"),
            rs.getString("status"),
            rs.getString("assignee"),
            rs.getString("priority"),
            rs.getString("created")));
  }

  private MutableIssue requireIssue(String key) {
    String normalizedKey = normalizeIssueKey(key);
    List<MutableIssue> rows = jdbc.query(
        "SELECT issue_key, summary, description, status, assignee, priority, created FROM issues WHERE issue_key = ?",
        (rs, rowNum) -> new MutableIssue(
            rs.getString("issue_key"),
            rs.getString("summary"),
            rs.getString("description"),
            rs.getString("status"),
            rs.getString("assignee"),
            rs.getString("priority"),
            rs.getString("created")),
        normalizedKey);
    if (rows.isEmpty()) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Issue not found: " + normalizedKey);
    }
    return rows.get(0);
  }

  private List<MutableComment> commentsFor(String key) {
    return jdbc.query(
        "SELECT id, issue_key, body_json, author, created FROM comments WHERE issue_key = ? ORDER BY id",
        (rs, rowNum) -> new MutableComment(
            rs.getLong("id"),
            rs.getString("issue_key"),
            rs.getString("body_json"),
            rs.getString("author"),
            rs.getString("created")),
        key);
  }

  private String insertGeneratedIssue(IssueInput input) {
    return insertIssue(nextIssueKey(), input);
  }

  private String insertConfiguredIssue(IssueInput input) {
    String key = input.key() == null || input.key().isBlank() ? nextIssueKey() : normalizeIssueKey(input.key());
    return insertIssue(key, input);
  }

  private String insertIssue(String key, IssueInput input) {
    jdbc.update(
        """
        INSERT INTO issues(issue_key, summary, description, status, assignee, priority, created)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(issue_key) DO UPDATE SET
          summary = excluded.summary,
          description = excluded.description,
          status = excluded.status,
          assignee = excluded.assignee,
          priority = excluded.priority
        """,
        key,
        input.summary(),
        input.description() == null ? "" : input.description(),
        input.status() == null ? "To Do" : input.status(),
        input.assignee() == null ? "Unassigned" : input.assignee(),
        input.priority() == null ? "Medium" : input.priority(),
        Instant.now().toString());
    return key;
  }

  private void updateIssue(String key, IssueUpdateInput input) {
    MutableIssue current = requireIssue(key);
    jdbc.update(
        """
        UPDATE issues
        SET summary = ?, description = ?, status = ?, assignee = ?, priority = ?
        WHERE issue_key = ?
        """,
        input.summary() == null ? current.summary() : input.summary(),
        input.description() == null ? current.description() : input.description(),
        input.status() == null ? current.status() : input.status(),
        input.assignee() == null ? current.assignee() : input.assignee(),
        input.priority() == null ? current.priority() : input.priority(),
        key);
  }

  private void deleteIssue(String key) {
    requireIssue(key);
    jdbc.update("DELETE FROM comments WHERE issue_key = ?", key);
    jdbc.update("DELETE FROM issues WHERE issue_key = ?", key);
  }

  private String nextIssueKey() {
    return allIssues().stream()
        .map(MutableIssue::key)
        .map(this::issueNumber)
        .max(Integer::compareTo)
        .map(next -> "%s-%05d".formatted(ISSUE_PREFIX, next + 1))
        .orElse("%s-00001".formatted(ISSUE_PREFIX));
  }

  private int issueNumber(String key) {
    Matcher matcher = ISSUE_KEY_PATTERN.matcher(key == null ? "" : key.trim());
    if (!matcher.matches()) {
      return 0;
    }
    return Integer.parseInt(matcher.group(2));
  }

  private String normalizeIssueKey(String key) {
    if (key == null || key.isBlank()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Issue key is required");
    }
    Matcher matcher = ISSUE_KEY_PATTERN.matcher(key.trim());
    if (!matcher.matches()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid issue key: " + key);
    }
    return "%s-%05d".formatted(ISSUE_PREFIX, Integer.parseInt(matcher.group(2)));
  }

  private Map<String, Object> issuePayload(MutableIssue issue) {
    Map<String, Object> fields = new LinkedHashMap<>();
    fields.put("summary", issue.summary());
    fields.put("description", issue.description());
    fields.put("issuetype", Map.of("name", "Defect"));
    fields.put("status", Map.of("name", issue.status()));
    fields.put("assignee", Map.of(
        "accountId", issue.assignee().toLowerCase().replaceAll("[^a-z0-9]+", "-"),
        "displayName", issue.assignee(),
        "name", issue.assignee()));
    fields.put("priority", Map.of("name", issue.priority()));
    fields.put("created", issue.created());
    List<Map<String, Object>> comments = commentsFor(issue.key()).stream()
        .map(this::commentPayload)
        .toList();
    fields.put("comment", Map.of("comments", comments, "total", comments.size()));
    return Map.of(
        "id", issue.key().replaceAll("\\D+", ""),
        "key", issue.key(),
        "self", "%s/rest/api/3/issue/%s".formatted(baseUrl, issue.key()),
        "fields", fields);
  }

  private Map<String, Object> commentPayload(MutableComment comment) {
    return Map.of(
        "id", Long.toString(comment.id()),
        "self", "%s/rest/api/3/issue/%s/comment/%s".formatted(baseUrl, comment.issueKey(), comment.id()),
        "author", Map.of("displayName", comment.author(), "accountId", "mock-user-account"),
        "body", fromJson(comment.bodyJson()),
        "created", comment.created(),
        "updated", comment.created());
  }

  private Object fromJson(String json) {
    try {
      return objectMapper.readValue(json, Object.class);
    } catch (JsonProcessingException ex) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Invalid persisted JSON", ex);
    }
  }

  private String toJson(Object value) {
    try {
      return objectMapper.writeValueAsString(value);
    } catch (JsonProcessingException ex) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Comment body is not JSON serializable", ex);
    }
  }

  private List<Transition> transitionsFor(String status) {
    return switch (status) {
      case "To Do" -> List.of(new Transition("11", "Start Progress", "In Progress"));
      case "In Progress" -> List.of(
          new Transition("21", "Request Review", "In Review"),
          new Transition("31", "Done", "Done"));
      case "In Review" -> List.of(
          new Transition("41", "Reopen", "In Progress"),
          new Transition("31", "Done", "Done"));
      default -> List.of(new Transition("51", "Reopen", "In Progress"));
    };
  }

  private void seedDefaultScenario() {
    insertConfiguredIssue(new IssueInput(
        "TK-00001",
        "Create payment link audit trail",
        "Exercise GitLab, Jenkins, Jira comments and transitions from the Kind integration test environment.",
        "In Progress",
        "Mock Trust User",
        "High"));
    jdbc.update(
        "INSERT INTO comments(issue_key, body_json, author, created) VALUES (?, ?, ?, ?)",
        "TK-00001",
        toJson("Initial test environment comment seeded by jira-mock."),
        "Mock Trust User",
        Instant.now().toString());
    insertConfiguredIssue(new IssueInput(
        "TK-00002",
        "Verify asynchronous payment event evidence",
        "Secondary ticket used to validate sprint aggregation and transition edges.",
        "To Do",
        "Unassigned",
        "Medium"));
    insertConfiguredIssue(new IssueInput(
        "TK-00003",
        "Ticket without runtime evidence",
        "Sample ticket intentionally missing OpenTelemetry acceptance evidence.",
        "In Progress",
        "Mock Trust User",
        "Medium"));
    insertConfiguredIssue(new IssueInput(
        "TK-00004",
        "Payment link response must expose expiration date",
        "Acceptance requires POST /payment-links to expose an expiresAt field derived from ttlSeconds and persisted with the payment link.",
        "In Progress",
        "Mock Trust User",
        "High"));
    insertConfiguredIssue(new IssueInput(
        "TK-00005",
        "Payment link response must expose audit label",
        "Acceptance requires POST /payment-links to expose auditLabel equal to the request label so the agent can diagnose the response contract from telemetry.",
        "In Progress",
        "Mock Trust User",
        "High"));
    insertConfiguredIssue(new IssueInput(
        "TK-00006",
        "Payment flow must expose stored event status across services",
        "Acceptance requires the payment response and persisted event-store read model to expose the same stored event status, engaging payment-api and event-store.",
        "In Progress",
        "Mock Trust User",
        "High"));
    insertConfiguredIssue(new IssueInput(
        "TK-00007",
        "Propagate merchant reference through the payment flow",
        "Add merchantReference to POST /payment-links and propagate it through payment-api, payment-worker, the payment event and event-store projection. The payment-acceptance Project is in scope: its feature branch must introduce the new Karate criterion first and prove RED against the accepted Kind baseline before service implementation begins.",
        "To Do",
        "Mock Trust User",
        "High"));
    jdbc.update(
        "INSERT INTO comments(issue_key, body_json, author, created) VALUES (?, ?, ?, ?)",
        "TK-00007",
        toJson("Acceptance lifecycle: branch payment-acceptance first, add the merchantReference criterion, record expected RED, then branch and modify only the Projects identified by the baseline trace."),
        "Mock Trust User",
        Instant.now().toString());
  }

  record CommentInput(@NotNull Object body) {}
  record TransitionInput(@Valid @NotNull TransitionRef transition) {}
  record TransitionRef(@NotBlank String id) {}
  record IssueInput(
      String key,
      @NotBlank String summary,
      String description,
      String status,
      String assignee,
      String priority) {}
  record IssueUpdateInput(
      String summary,
      String description,
      String status,
      String assignee,
      String priority) {}
  record ScenarioInput(List<IssueInput> issues) {}
  record Transition(String id, String name, String toStatus) {}
  record MutableIssue(
      String key,
      String summary,
      String description,
      String status,
      String assignee,
      String priority,
      String created) {}
  record MutableComment(long id, String issueKey, String bodyJson, String author, String created) {}
}
