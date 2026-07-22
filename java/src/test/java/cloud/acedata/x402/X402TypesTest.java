package cloud.acedata.x402;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Map;
import org.junit.jupiter.api.Test;

class X402TypesTest {
    @Test
    void networkWireNamesAreCanonical() {
        assertEquals("eip155:8453", X402Types.Network.BASE.wire());
        assertEquals("eip155:1187947933", X402Types.Network.SKALE.wire());
        assertEquals("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", X402Types.Network.SOLANA.wire());
    }

    @Test
    void officialAmountTakesPrecedence() {
        var requirement = new X402Types.PaymentRequirement(
                "exact",
                X402Types.Network.BASE.wire(),
                "952",
                "legacy",
                120,
                "/serp/google",
                "test",
                "0x1111111111111111111111111111111111111111",
                "0x2222222222222222222222222222222222222222",
                Map.of());

        assertEquals("952", requirement.amount());
        assertEquals("952", requirement.effectiveAmount());
    }

    @SuppressWarnings("deprecation")
    @Test
    void legacyConstructorRemainsReadable() {
        var requirement = new X402Types.PaymentRequirement(
                "exact",
                X402Types.Network.BASE.wire(),
                "952",
                120,
                "/serp/google",
                "test",
                "0x1111111111111111111111111111111111111111",
                "0x2222222222222222222222222222222222222222",
                Map.of());

        assertNull(requirement.amount());
        assertEquals("952", requirement.effectiveAmount());
    }
}