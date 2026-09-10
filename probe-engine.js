/**
 * FortiGate Dual-WAN Link Degradation Monitor
 * Degradation Simulator Engine (demo / alert testing only)
 *
 * The previous local-ping fallback was removed: pinging 8.8.8.8 and 1.1.1.1 from the
 * monitoring PC goes out through whichever link the FortiGate load-balances to, so it
 * cannot measure WAN1 and WAN2 separately and produced misleading per-link numbers.
 */

class ProbeEngine {
  constructor(options = {}) {
    this.targets = options.targets || ['8.8.8.8', '1.1.1.1'];
    this.simulationEnabled = options.simulationEnabled ?? false;
    
    // Internal simulation state
    this.simState = {
      wan1: {
        baseLatency: 24,
        jitter: 2.1,
        loss: 0,
        status: 'up',
        simulatedCondition: 'normal', // 'normal', 'latency_spike', 'packet_loss', 'down'
        rxKbps: 4500,
        txKbps: 1200
      },
      wan2: {
        baseLatency: 38,
        jitter: 4.5,
        loss: 0,
        status: 'up',
        simulatedCondition: 'normal',
        rxKbps: 3200,
        txKbps: 950
      }
    };
  }

  setSimulation(enabled) {
    this.simulationEnabled = enabled;
  }

  setSimulatedCondition(linkId, condition) {
    if (this.simState[linkId]) {
      this.simState[linkId].simulatedCondition = condition;
    }
  }

  /**
   * Generates a realistic simulation sample for testing & UI preview
   */
  getSimulatedMetrics() {
    const generateForLink = (linkId) => {
      const state = this.simState[linkId];
      let latency = state.baseLatency + (Math.random() * 6 - 3);
      let jitter = state.jitter + (Math.random() * 1.5 - 0.7);
      let loss = 0;
      let status = 'up';
      let rxKbps = state.rxKbps + (Math.random() * 600 - 300);
      let txKbps = state.txKbps + (Math.random() * 200 - 100);

      switch (state.simulatedCondition) {
        case 'latency_spike':
          latency += 220 + (Math.random() * 50);
          jitter += 35 + (Math.random() * 15);
          loss = Math.random() < 0.2 ? 2.5 : 0;
          break;

        case 'packet_loss':
          latency += 80 + (Math.random() * 40);
          jitter += 25;
          loss = 12.5 + (Math.random() * 8.0); // 12% - 20% loss
          break;

        case 'down':
          latency = null;
          jitter = null;
          loss = 100;
          status = 'down';
          rxKbps = 0;
          txKbps = 0;
          break;

        case 'intermittent_flap':
          if (Math.random() < 0.4) {
            loss = 35;
            latency += 180;
          }
          break;

        case 'normal':
        default:
          loss = Math.random() < 0.05 ? 0.5 : 0;
          break;
      }

      return {
        interface: linkId,
        latency: latency === null ? null : Math.max(0, parseFloat(latency.toFixed(1))),
        jitter: jitter === null ? null : Math.max(0, parseFloat(jitter.toFixed(1))),
        packetLoss: Math.min(100, Math.max(0, parseFloat(loss.toFixed(1)))),
        status: status,
        rxKbps: Math.max(0, parseFloat(rxKbps.toFixed(0))),
        txKbps: Math.max(0, parseFloat(txKbps.toFixed(0))),
        carrierDown: false,
        source: 'simulation',
        condition: state.simulatedCondition
      };
    };

    return {
      wan1: generateForLink('wan1'),
      wan2: generateForLink('wan2')
    };
  }
}

module.exports = ProbeEngine;
