package dev.trust.jiramock;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        "spring.datasource.url=jdbc:sqlite:file:jira-mock-it?mode=memory&cache=shared",
        "jira-mock.base-url=http://jira.test"
    })
class JiraMockIntegrationTest {
  private final HttpClient http = HttpClient.newHttpClient();

  @LocalServerPort
  private int port;

  @Autowired
  private ObjectMapper objectMapper;

  @Test
  void createsEditsCommentsTransitionsDeletesAndRendersCrudUi() throws Exception {
    HttpResponse<String> dashboard = get("/");
    assertThat(dashboard.statusCode()).isEqualTo(200);
    assertThat(dashboard.body())
        .contains("Jira Mock")
        .contains("Nouveau ticket")
        .contains("Comments");

    HttpResponse<String> created = post("/__admin/issues", """
        {
          "key": "TR-99999",
          "summary": "Integration ticket from IT",
          "description": "Created with an ignored key so Jira mock assigns the next TK id.",
          "status": "To Do",
          "assignee": "Integration Tester",
          "priority": "High"
        }
        """);
    assertThat(created.statusCode()).as(created.body()).isEqualTo(201);
    JsonNode createdIssue = objectMapper.readTree(created.body());
    assertThat(createdIssue.at("/key").asText()).isEqualTo("TK-00008");
    assertThat(createdIssue.at("/fields/status/name").asText()).isEqualTo("To Do");

    HttpResponse<String> edited = put("/__admin/issues/8", """
        {
          "summary": "Edited integration ticket",
          "priority": "Medium"
        }
        """);
    assertThat(edited.statusCode()).isEqualTo(200);
    JsonNode editedIssue = objectMapper.readTree(edited.body());
    assertThat(editedIssue.at("/key").asText()).isEqualTo("TK-00008");
    assertThat(editedIssue.at("/fields/summary").asText()).isEqualTo("Edited integration ticket");
    assertThat(editedIssue.at("/fields/priority/name").asText()).isEqualTo("Medium");

    HttpResponse<String> comment = post("/rest/api/3/issue/8/comment", """
        {
          "body": "IT comment added through the Jira-compatible API."
        }
        """);
    assertThat(comment.statusCode()).isEqualTo(201);
    JsonNode commentBody = objectMapper.readTree(comment.body());
    assertThat(commentBody.at("/body").asText()).isEqualTo("IT comment added through the Jira-compatible API.");

    HttpResponse<String> transitioned = post("/rest/api/3/issue/TK-00008/transitions", """
        {
          "transition": {
            "id": "11"
          }
        }
        """);
    assertThat(transitioned.statusCode()).isEqualTo(204);

    HttpResponse<String> current = get("/rest/api/3/issue/TK-00008");
    assertThat(current.statusCode()).isEqualTo(200);
    JsonNode currentIssue = objectMapper.readTree(current.body());
    assertThat(currentIssue.at("/fields/status/name").asText()).isEqualTo("In Progress");
    assertThat(currentIssue.at("/fields/comment/total").asInt()).isEqualTo(1);

    HttpResponse<String> searched = get("/rest/api/3/search/jql?jql=key%20%3D%20TK-00007");
    assertThat(searched.statusCode()).isEqualTo(200);
    JsonNode searchResult = objectMapper.readTree(searched.body());
    assertThat(searchResult.at("/total").asInt()).isEqualTo(1);
    assertThat(searchResult.at("/issues/0/key").asText()).isEqualTo("TK-00007");

    HttpResponse<String> issuePage = get("/?issue=TK-00008");
    assertThat(issuePage.statusCode()).isEqualTo(200);
    assertThat(issuePage.body())
        .contains("TK-00008")
        .contains("Edited integration ticket")
        .contains("IT comment added through the Jira-compatible API.");

    HttpResponse<String> browseLink = get("/browse/TK-00008");
    assertThat(browseLink.statusCode()).isEqualTo(302);
    assertThat(browseLink.headers().firstValue("location"))
        .hasValueSatisfying(location -> assertThat(location).endsWith("/?issue=TK-00008"));

    HttpResponse<String> deleted = delete("/rest/api/3/issue/TK-00008");
    assertThat(deleted.statusCode()).isEqualTo(204);

    HttpResponse<String> deletedIssue = get("/rest/api/3/issue/TK-00008");
    assertThat(deletedIssue.statusCode()).isEqualTo(404);
  }

  private HttpResponse<String> get(String path) throws Exception {
    return http.send(
        HttpRequest.newBuilder(uri(path)).GET().build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private HttpResponse<String> post(String path, String body) throws Exception {
    return http.send(
        HttpRequest.newBuilder(uri(path))
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private HttpResponse<String> put(String path, String body) throws Exception {
    return http.send(
        HttpRequest.newBuilder(uri(path))
            .header("content-type", "application/json")
            .PUT(HttpRequest.BodyPublishers.ofString(body))
            .build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private HttpResponse<String> delete(String path) throws Exception {
    return http.send(
        HttpRequest.newBuilder(uri(path)).DELETE().build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private URI uri(String path) {
    return URI.create("http://127.0.0.1:%d%s".formatted(port, path));
  }
}
