package cloud.acedata.x402;

import java.util.List;
import java.util.Map;

/**
 * Types for the X402 payment protocol.
 *
 * <p>Mirrors {@code typescript/src/types.ts} and {@code python/src/acedatacloud_x402/types.py}.
 */
public final class X402Types {
    private X402Types() {}

    /** Supported payment networks. */
    public enum Network {
        BASE("base"),
        SKALE("skale"),
        SOLANA("solana");

        private final String wire;

        Network(String wire) {
            this.wire = wire;
        }

        /** Returns the lowercase wire name used on the server. */
        public String wire() {
            return wire;
        }

        public static Network fromWire(String value) {
            if (value == null) {
                throw new IllegalArgumentException("network is null");
            }
            for (Network n : values()) {
                if (n.wire.equalsIgnoreCase(value)) {
                    return n;
                }
            }
            throw new IllegalArgumentException("Unsupported network: " + value);
        }
    }

    /**
     * A single entry from the server's 402 {@code accepts} list.
     *
     * <p>This is a lightweight, schema-tolerant view over the JSON — all fields are
     * plain strings / maps so we never fail to parse due to new server fields.
     */
    public static final class PaymentRequirement {
        private final String scheme;
        private final String network;
        private final String maxAmountRequired;
        private final int maxTimeoutSeconds;
        private final String resource;
        private final String description;
        private final String payTo;
        private final String asset;
        private final Map<String, Object> extra;

        public PaymentRequirement(
                String scheme,
                String network,
                String maxAmountRequired,
                int maxTimeoutSeconds,
                String resource,
                String description,
                String payTo,
                String asset,
                Map<String, Object> extra) {
            this.scheme = scheme;
            this.network = network;
            this.maxAmountRequired = maxAmountRequired;
            this.maxTimeoutSeconds = maxTimeoutSeconds;
            this.resource = resource;
            this.description = description;
            this.payTo = payTo;
            this.asset = asset;
            this.extra = extra == null ? Map.of() : Map.copyOf(extra);
        }

        public String scheme() {
            return scheme;
        }

        public String network() {
            return network;
        }

        public String maxAmountRequired() {
            return maxAmountRequired;
        }

        public int maxTimeoutSeconds() {
            return maxTimeoutSeconds;
        }

        public String resource() {
            return resource;
        }

        public String description() {
            return description;
        }

        public String payTo() {
            return payTo;
        }

        public String asset() {
            return asset;
        }

        public Map<String, Object> extra() {
            return extra;
        }

        /** Read an integer field from {@link #extra()}, returning {@code defaultValue} if absent. */
        public int extraInt(String key, int defaultValue) {
            Object v = extra.get(key);
            if (v == null) {
                return defaultValue;
            }
            if (v instanceof Number n) {
                return n.intValue();
            }
            return Integer.parseInt(v.toString());
        }

        /** Read a string field from {@link #extra()}, returning {@code defaultValue} if absent. */
        public String extraString(String key, String defaultValue) {
            Object v = extra.get(key);
            return v == null ? defaultValue : v.toString();
        }
    }

    /** 402 Payment Required body. */
    public static final class PaymentRequiredBody {
        private final int x402Version;
        private final List<PaymentRequirement> accepts;
        private final String error;

        public PaymentRequiredBody(int x402Version, List<PaymentRequirement> accepts, String error) {
            this.x402Version = x402Version;
            this.accepts = accepts == null ? List.of() : List.copyOf(accepts);
            this.error = error;
        }

        public int x402Version() {
            return x402Version;
        }

        public List<PaymentRequirement> accepts() {
            return accepts;
        }

        public String error() {
            return error;
        }
    }
}
