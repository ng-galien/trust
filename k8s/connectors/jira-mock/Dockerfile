FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/target/jira-mock-0.0.1-SNAPSHOT.jar /app/jira-mock.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/jira-mock.jar"]
