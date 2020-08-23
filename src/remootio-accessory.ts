/* Copyright (C) 2020 Ronnie Pettersson. All rights reserved
 *
 *  remootio-accessory.ts: Base class for Remootio accessories
 *
 */

import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  HAP,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  Logging,
  Service,
  Characteristic,
} from 'homebridge';

import RemootioDevice = require('remootio-api-client');

// Here are a subset of the Remootio API payloads sent by the device over web sockets
type RemootioEncryptedPayload = {
  type: 'ENCRYPTED';
  data: {
    payload: string;
    iv: string;
  };
  mac: string;
};
type RemootioError = {
  type: 'ERROR';
  errorMessage: string;
};
type RemootioPing = {
  type: 'PING';
};
type RemootioHello = {
  type: 'HELLO';
  apiVersion: number;
  message: string;
};

interface RemootioChallenge {
  challenge: {
    sessionKey: string;
    initialActionId: number;
  };
}

interface RemootioEvent {
  event: {
    cnt: number;
    type: string;
    state: string;
    t100ms: number;
    data?: {
      keyNr?: number;
      keyType?: string;
      via?: string;
      imeOpen100ms?: number;
    };
  };
}
/*
interface RemootioStateChangeEvent {
  event: {
    cnt: number;
    type: 'StateChange';
    state: string;
    t100ms: number;
  };
}

interface RemootioTriggeredEvent {
  event: {
    cnt: number;
    type: string;
    state: string;
    t100ms: number;
    data: {
      keyNr: number;
      keyType: string;
      via: string;
    };
  };
}
interface RemootioLeftOpen {
  event: {
    cnt: number;
    type: 'LeftOpen';
    state: string;
    t100ms: number;
    data: {
      timeOpen100ms: number;
    };
  };
}
*/
interface RemootioResponse {
  response: {
    type: string;
    id: number;
    success: boolean;
    state: string;
    t100ms: number;
    relayTriggered: boolean;
    errorCode: string;
  };
}

type RemootioTypedFrame = RemootioEncryptedPayload | RemootioError | RemootioPing | RemootioHello;

type RemootioFrame = RemootioTypedFrame & RemootioChallenge;

//type RemootioDecryptedPayload = RemootioStateChangeEvent & RemootioTriggeredEvent & RemootioLeftOpen & RemootioResponse;
type RemootioDecryptedPayload = RemootioEvent & RemootioResponse;

let device: RemootioDevice;

const garageDoorOpenerStateToString: string[] = ['OPEN', 'CLOSED', 'OPENING', 'CLOSING', 'STOPPED'];

export class RemootioHomebridgeAccessory implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly hap: HAP;
  private readonly name: string;

  // TODO
  private readonly ipAddress: string;
  private readonly apiSecretKey: string;
  private readonly apiAuthKey: string;
  private readonly pingInterval = 60000;

  private readonly currentDoorState: typeof Characteristic.CurrentDoorState;
  private readonly targetDoorState: typeof Characteristic.TargetDoorState;

  private currentState = -1; // To detect whether we have recevied an update
  private targetState = -1;

  private readonly device: RemootioDevice;

  private readonly garageDoorOpenerService!: Service;
  private readonly informationService!: Service;

  // The constructor initializes variables
  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.api = api;
    this.hap = this.api.hap;
    this.log = log;

    this.currentDoorState = this.hap.Characteristic.CurrentDoorState;
    this.targetDoorState = this.hap.Characteristic.TargetDoorState;

    // From configuration of this accessory
    this.name = config.name;
    this.ipAddress = config.ipAddress;
    this.apiSecretKey = config.apiSecretKey;
    this.apiAuthKey = config.apiAuthKey;

    log.debug('IP: ' + this.ipAddress);
    log.debug('SK: ' + this.apiSecretKey);
    log.debug('AK: ' + this.apiAuthKey);

    // If we don't have all the required configuration parameters, don't continue
    if (this.ipAddress === undefined || this.apiSecretKey === undefined || this.apiAuthKey === undefined) {
      log.warn('Missing required config parameters, exiting');
      return;
    }

    // Add a new Remootio device using remootio-api-client library
    device = new RemootioDevice(this.ipAddress, this.apiSecretKey, this.apiAuthKey, this.pingInterval);
    this.device = device;

    // Creating new Garage door opener service
    this.garageDoorOpenerService = new this.hap.Service.GarageDoorOpener(this.name);

    // Registering the listeners for the required characteristics
    // https://developers.homebridge.io/#/service/GarageDoorOpener
    this.garageDoorOpenerService
      .getCharacteristic(this.hap.Characteristic.CurrentDoorState)
      .on(CharacteristicEventTypes.GET, this.getCurrentStateHandler.bind(this));

    this.garageDoorOpenerService
      .getCharacteristic(this.hap.Characteristic.TargetDoorState)
      .on(CharacteristicEventTypes.GET, this.getTargetStateHandler.bind(this));

    this.garageDoorOpenerService
      .getCharacteristic(this.hap.Characteristic.TargetDoorState)
      .on(CharacteristicEventTypes.SET, this.setTargetStateHandler.bind(this));

    this.garageDoorOpenerService
      .getCharacteristic(this.hap.Characteristic.ObstructionDetected)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        // Dummy return as this is not supported by Remootio devices at this point
        log.debug('ObstructionDetected was requested');
        callback(null, false);
      });

    this.informationService = new this.hap.Service.AccessoryInformation()
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Remootio')
      .setCharacteristic(this.hap.Characteristic.Model, 'Remootio');

    // Registering the listeners for the Remootio API client
    // https://documents.remootio.com/docs/WebsocketApiDocs.pdf
    this.device.on('error', (err) => {
      log.error('whoops! there was an error: ' + err);
    });

    this.device.addListener('connected', () => {
      log.info(this.name + ' connected');
      this.device.authenticate(); //Authenticate the session (required)
    });

    this.device.addListener('authenticated', () => {
      log.info(this.name + ' authenticated');
      //this.device.sendQuery();
    });

    this.device.addListener('disconnect', (msg: string) => {
      log.info(this.name + ' ' + msg);
      //this.device.sendQuery();
    });

    this.device.addListener('incomingmessage', (frame: RemootioFrame, decryptedPayload: RemootioDecryptedPayload) => {
      this.handleIncomingMessage(frame, decryptedPayload);
    });

    // Request to connect with Remootio device with auto-reconnect = true
    this.device.connect(true);

    log.info('Remootio Garage Door Opener finished initializing!');
  }

  handleIncomingMessage(frame: RemootioFrame, decryptedPayload: RemootioDecryptedPayload): void {
    if (decryptedPayload !== undefined) {
      const rowToLog = new Date().toISOString() + ' ' + JSON.stringify(decryptedPayload);
      this.log.debug(rowToLog);

      if (decryptedPayload.event !== undefined && decryptedPayload.event.state !== undefined) {
        if (decryptedPayload.event.type === 'StateChange') {
          this.setCurrentDoorState(decryptedPayload.event.state);
        }
        if (decryptedPayload.event.type === 'RelayTrigger' && decryptedPayload.event.state === 'open') {
          this.setCurrentDoorState('closing');
        }
        if (decryptedPayload.event.type === 'RelayTrigger' && decryptedPayload.event.state === 'closed') {
          this.setCurrentDoorState('opening');
        }
      }
      if (decryptedPayload.response !== undefined && decryptedPayload.response.state !== undefined) {
        const rowToLog = new Date().toISOString() + decryptedPayload.response.type;
        this.log.info(rowToLog);
        if (decryptedPayload.response.type === 'QUERY') {
          this.setCurrentDoorState(decryptedPayload.response.state);
        }
      }
    } else {
      if (frame !== undefined) {
        if (frame.challenge === undefined && frame.type !== undefined) {
          const rowToLog = new Date().toISOString() + ' ' + frame.type;
          this.log.debug(rowToLog);
        } else if (frame.challenge !== undefined) {
          const rowToLog = new Date().toISOString() + ' Challenge';
          this.log.info(rowToLog);
        }
      }
    }
  }

  setCurrentDoorState(state: string) {
    switch (state) {
      case 'open':
        this.currentState = this.currentDoorState.OPEN;
        this.log.info('Setting current state to OPEN');
        this.garageDoorOpenerService!.getCharacteristic(this.hap.Characteristic.CurrentDoorState)!.updateValue(
          this.currentDoorState.OPEN,
        );
        break;
      case 'closed':
        this.currentState = this.currentDoorState.CLOSED;
        this.log.info('Setting current state to CLOSED');
        this.garageDoorOpenerService!.getCharacteristic(this.hap.Characteristic.CurrentDoorState)!.updateValue(
          this.currentDoorState.CLOSED,
        );
        break;
      case 'opening':
        this.currentState = this.currentDoorState.OPENING;
        this.log.info('Setting current state to OPENING');
        this.garageDoorOpenerService!.getCharacteristic(this.hap.Characteristic.CurrentDoorState)!.updateValue(
          this.currentDoorState.OPENING,
        );
        break;
      case 'closing':
        this.currentState = this.currentDoorState.CLOSING;
        this.log.info('Setting current state to CLOSING');
        this.garageDoorOpenerService!.getCharacteristic(this.hap.Characteristic.CurrentDoorState)!.updateValue(
          this.currentDoorState.CLOSING,
        );
        break;
    }
  }

  getCurrentStateHandler(callback: CharacteristicGetCallback): void {
    this.log.debug(
      'getCurrentStateHandler: Current door state: [' +
        this.currentState +
        '] ' +
        (this.currentState === this.currentDoorState.OPEN ? 'Open' : 'Closed'),
    );
    if (this.currentState < 0) {
      callback(new Error('No value available'));
    } else {
      // Always return current state, so that the server does not emit an event to HAP
      callback(null, this.currentState);
    }
    // Always send a query request to the garage door opener. When the request returned, send the event via setCurrentDoorState()
    this.device.sendQuery();
  }

  getTargetStateHandler(callback: CharacteristicGetCallback): void {
    this.log.debug(
      'getTargetStateHandler: Target door state: [' +
        this.targetState +
        '] ' +
        (this.targetState === this.targetDoorState.OPEN ? 'Open' : 'Closed'),
    );
    if (this.targetState < 0) {
      if (this.currentState < 0) {
        callback(new Error('No value available'));
        return;
      } else {
        this.targetState = this.currentState;
        this.log.info('Target state is uninitialized, setting target state same as current state');
      }
    }
    callback(null, this.targetState);
  }

  /*
   * This method implements the logic for sending open or close to the devices.
   * In current implementation, it will not resend a command if the target door state is the same as previous call.
   */
  setTargetStateHandler(newValue: CharacteristicValue, callback: CharacteristicSetCallback): void {
    // call sendOpen or sendClose based on value

    if (newValue === undefined || newValue === null) {
      this.log.debug('setTargetStateHandler: invalid newValue');
      callback(new Error('no value'));
      return;
    }
    const oldState = this.targetState;
    const newState = newValue as number;

    this.log.info(
      'setTargetStateHandler: New value: ' +
        garageDoorOpenerStateToString[newState] +
        ' Old value: ' +
        garageDoorOpenerStateToString[oldState],
    );
    if (newState !== oldState) {
      if (!this.device.isConnected || !this.device.isAuthenticated) {
        this.log.info('Device is not connected');
        callback(new Error('Not Connected'));
        return;
      }
      this.targetState = newState;
      if (newState === this.targetDoorState.OPEN) {
        this.log.info('Sending sendOpen()');
        this.device.sendOpen();
      } else if (newState === this.targetDoorState.CLOSED) {
        this.log.info('Sending sendClose()');
        this.device.sendClose();
      }
    }

    callback(null);
  }

  /*
   * This method is optional to implement. It is called when HomeKit ask to identify the accessory.
   * Typical this only ever happens at the pairing process.
   */
  identify(): void {
    this.log('Identify!');
  }

  /*
   * This method is called directly after creation of this instance.
   * It should return all services which should be added to the accessory.
   */
  getServices(): Service[] {
    return [this.informationService, this.garageDoorOpenerService];
  }
}
