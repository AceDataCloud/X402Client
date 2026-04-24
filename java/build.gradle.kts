plugins {
    `java-library`
    `maven-publish`
}

group = "cloud.acedata"
version = project.findProperty("version")?.takeIf { it != "unspecified" }?.toString() ?: "0.1.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
    withSourcesJar()
    withJavadocJar()
}

repositories {
    mavenCentral()
}

dependencies {
    // JSON
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.2")

    // EVM: web3j for EIP-712 typed-data hashing and ECDSA signing
    implementation("org.web3j:core:4.12.3")
    implementation("org.web3j:crypto:4.12.3")

    // Solana: sol4k (pure JVM client)
    implementation("org.sol4k:sol4k:0.5.17")

    // Tests
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.named<Test>("test") {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
}

tasks.named<Javadoc>("javadoc") {
    (options as StandardJavadocDocletOptions).addStringOption("Xdoclint:none", "-quiet")
    isFailOnError = false
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])

            artifactId = "x402-client"

            pom {
                name.set("AceDataCloud X402 Client")
                description.set("X402 payment protocol client for AceDataCloud APIs")
                url.set("https://github.com/AceDataCloud/X402Client")
                licenses {
                    license {
                        name.set("MIT")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        id.set("acedatacloud")
                        name.set("AceDataCloud")
                        email.set("support@acedata.cloud")
                    }
                }
                scm {
                    url.set("https://github.com/AceDataCloud/X402Client")
                    connection.set("scm:git:https://github.com/AceDataCloud/X402Client.git")
                    developerConnection.set("scm:git:git@github.com:AceDataCloud/X402Client.git")
                }
            }
        }
    }

    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/AceDataCloud/X402Client")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: project.findProperty("gpr.user") as String?
                password = System.getenv("GITHUB_TOKEN") ?: project.findProperty("gpr.key") as String?
            }
        }
    }
}
