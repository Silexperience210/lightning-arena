/**
 * LND gRPC Client Wrapper
 * Handles Lightning Network Daemon connection
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const path = require('path');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'lightning.proto');

// Load protobuf
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const lnrpc = grpc.loadPackageDefinition(packageDefinition).lnrpc;

class LightningClient {
  constructor(options) {
    this.options = options;
    this.client = null;
    this.connect();
  }

  connect() {
    const { server, macaroonPath, tlsCertPath } = this.options;
    
    // Load TLS cert
    const tlsCert = fs.readFileSync(tlsCertPath);
    const sslCreds = grpc.credentials.createSsl(tlsCert);
    
    // Load macaroon
    const macaroon = fs.readFileSync(macaroonPath).toString('hex');
    const macaroonCreds = grpc.credentials.createFromMetadataGenerator((args, callback) => {
      const metadata = new grpc.Metadata();
      metadata.add('macaroon', macaroon);
      callback(null, metadata);
    });
    
    // Combine credentials
    const credentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);
    
    // Create client
    this.client = new lnrpc.Lightning(server, credentials);
    
    console.log(`[LND] Connected to ${server}`);
  }

  // Add invoice
  addInvoice(params) {
    return new Promise((resolve, reject) => {
      this.client.addInvoice(params, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // Lookup invoice
  lookupInvoice(params) {
    return new Promise((resolve, reject) => {
      this.client.lookupInvoice(params, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // Send payment
  sendPaymentSync(params) {
    return new Promise((resolve, reject) => {
      this.client.sendPaymentSync(params, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // Get wallet balance
  walletBalance() {
    return new Promise((resolve, reject) => {
      this.client.walletBalance({}, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // Get channel balance
  channelBalance() {
    return new Promise((resolve, reject) => {
      this.client.channelBalance({}, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // Get info
  getInfo() {
    return new Promise((resolve, reject) => {
      this.client.getInfo({}, (err, response) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
  }

  // Subscribe to invoices (for real-time deposit notifications)
  subscribeInvoices() {
    return this.client.subscribeInvoices({});
  }
}

// Factory function
function createLightningClient(options) {
  return new LightningClient(options);
}

module.exports = { LightningClient, createLightningClient };
