package cloud.acedata.x402;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The pre-base64 representation of an {@code X-Payment} header.
 *
 * <p>Mirrors {@code X402PaymentEnvelope} in the TypeScript package. The {@link #payload()}
 * map is serialized verbatim to JSON by {@link X402PaymentHandler}, so the signer
 * controls the exact wire shape ({@code authorization}/{@code signature} for EVM,
 * {@code signature} for Solana, …).
 */
public final class X402PaymentEnvelope {
    private final int x402Version;
    private final String scheme;
    private final String network;
    private final Map<String, Object> payload;

    public X402PaymentEnvelope(int x402Version, String scheme, String network, Map<String, Object> payload) {
        this.x402Version = x402Version;
        this.scheme = Objects.requireNonNull(scheme, "scheme");
        this.network = Objects.requireNonNull(network, "network");
        // Preserve insertion order so JSON matches the reference SDKs byte-for-byte.
        this.payload = payload == null ? Map.of() : new LinkedHashMap<>(payload);
    }

    public int x402Version() {
        return x402Version;
    }

    public String scheme() {
        return scheme;
    }

    public String network() {
        return network;
    }

    public Map<String, Object> payload() {
        return payload;
    }

    /** Return a {@link LinkedHashMap} matching the envelope's JSON field order. */
    public Map<String, Object> toOrderedMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("x402Version", x402Version);
        out.put("scheme", scheme);
        out.put("network", network);
        out.put("payload", payload);
        return out;
    }
}
