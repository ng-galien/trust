FROM jenkins/jenkins:lts-jdk21
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git maven \
  && rm -rf /var/lib/apt/lists/*
USER jenkins
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt
