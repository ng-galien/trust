package dev.trust.jiramock;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@Controller
class JiraMockViewController {
  private static final List<String> STATUSES = List.of("To Do", "In Progress", "In Review", "Done");
  private static final List<String> PRIORITIES = List.of("Low", "Medium", "High", "Critical");

  private final String baseUrl;
  private final JdbcTemplate jdbc;
  private final ObjectMapper objectMapper;
  private final JiraMockController api;

  JiraMockViewController(
      @Value("${jira-mock.base-url}") String baseUrl,
      JdbcTemplate jdbc,
      ObjectMapper objectMapper,
      JiraMockController api) {
    this.baseUrl = baseUrl.replaceAll("/$", "");
    this.jdbc = jdbc;
    this.objectMapper = objectMapper;
    this.api = api;
  }

  @GetMapping("/")
  String index(@RequestParam Optional<String> issue, Model model) {
    List<IssueView> issues = issues();
    IssueView selectedIssue = issue
        .flatMap(key -> issues.stream().filter(row -> row.key().equals(normalizeKey(key))).findFirst())
        .or(() -> issues.stream().findFirst())
        .orElse(null);
    model.addAttribute("baseUrl", baseUrl);
    model.addAttribute("issues", issues);
    model.addAttribute("issueCount", issues.size());
    model.addAttribute("selectedIssue", selectedIssue);
    model.addAttribute("comments", selectedIssue == null ? List.of() : comments(selectedIssue.key()));
    model.addAttribute("statuses", STATUSES);
    model.addAttribute("priorities", PRIORITIES);
    return "jira-dashboard";
  }

  @PostMapping("/ui/issues")
  String createIssue(
      @RequestParam String summary,
      @RequestParam Optional<String> description,
      @RequestParam Optional<String> status,
      @RequestParam Optional<String> assignee,
      @RequestParam Optional<String> priority) {
    Map<String, Object> created = api.createIssue(new JiraMockController.IssueInput(
        null,
        summary,
        blankToNull(description),
        blankToNull(status),
        blankToNull(assignee),
        blankToNull(priority)));
    return redirectTo(created.get("key"));
  }

  @GetMapping("/browse/{key}")
  String browseIssue(@PathVariable String key) {
    return redirectTo(key);
  }

  @PostMapping("/ui/issues/{key}")
  String updateIssue(
      @PathVariable String key,
      @RequestParam Optional<String> summary,
      @RequestParam Optional<String> description,
      @RequestParam Optional<String> status,
      @RequestParam Optional<String> assignee,
      @RequestParam Optional<String> priority) {
    api.updateAdminIssue(key, new JiraMockController.IssueUpdateInput(
        blankToNull(summary),
        blankToNull(description),
        blankToNull(status),
        blankToNull(assignee),
        blankToNull(priority)));
    return redirectTo(key);
  }

  @PostMapping("/ui/issues/{key}/comments")
  String addComment(@PathVariable String key, @RequestParam String body) {
    api.addComment(key, new JiraMockController.CommentInput(body));
    return redirectTo(key);
  }

  @PostMapping("/ui/issues/{key}/delete")
  String deleteIssue(@PathVariable String key) {
    api.deleteAdminIssue(key);
    return "redirect:/";
  }

  private List<IssueView> issues() {
    return jdbc.query(
        "SELECT issue_key, summary, description, status, assignee, priority, created FROM issues",
        (rs, rowNum) -> new IssueView(
            rs.getString("issue_key"),
            rs.getString("summary"),
            rs.getString("description"),
            rs.getString("status"),
            rs.getString("assignee"),
            rs.getString("priority"),
            rs.getString("created"),
            "%s/rest/api/3/issue/%s".formatted(baseUrl, rs.getString("issue_key"))))
        .stream()
        .sorted(Comparator.comparing(IssueView::key))
        .toList();
  }

  private List<CommentView> comments(String key) {
    return jdbc.query(
        "SELECT id, body_json, author, created FROM comments WHERE issue_key = ? ORDER BY id DESC",
        (rs, rowNum) -> new CommentView(
            rs.getLong("id"),
            renderComment(rs.getString("body_json")),
            rs.getString("author"),
            rs.getString("created")),
        key);
  }

  private String renderComment(String bodyJson) {
    try {
      Object body = objectMapper.readValue(bodyJson, Object.class);
      if (body instanceof String text) {
        return text;
      }
      return objectMapper.writeValueAsString(body);
    } catch (JsonProcessingException ex) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not render comment", ex);
    }
  }

  private String normalizeKey(String key) {
    String digits = key == null ? "" : key.replaceAll("\\D+", "");
    if (digits.isBlank()) {
      return "";
    }
    return "TK-%05d".formatted(Integer.parseInt(digits));
  }

  private String blankToNull(Optional<String> value) {
    return value.map(String::trim).filter(text -> !text.isEmpty()).orElse(null);
  }

  private String redirectTo(Object key) {
    return "redirect:/?issue=%s".formatted(key);
  }

  record IssueView(
      String key,
      String summary,
      String description,
      String status,
      String assignee,
      String priority,
      String created,
      String url) {}

  record CommentView(long id, String body, String author, String created) {}
}
