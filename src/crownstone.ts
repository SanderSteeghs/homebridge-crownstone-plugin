import type { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';

import type { CrownstonePlatform } from './crownstone-platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Crownstone {
  private service: Service;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private state = {
    On: false,
  };

  constructor(
    private readonly platform: CrownstonePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly id: string,
    private readonly uid: number,
  ) {
    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Crownstone')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    this.service = this.accessory.getService(this.platform.Service.Switch) || this.accessory.addService(this.platform.Service.Switch);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Switch

    // create handlers for required characteristics
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));
  }

  handleUpdateOn(newValue: number) {
    this.platform.log.debug('Updated crownstone ', this.id, ' to ', newValue);
    this.state.On = newValue > 0;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.state.On);
  }

  /**
   * Handle requests to get the current value of the "On" characteristic
   */
  handleOnGet() {
    this.platform.log.debug('Triggered GET On');
    return this.state.On;
  }

  /**
   * Handle requests to set the "On" characteristic
   */
  async handleOnSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET On:', value);

    const percentage = value ? 100 : 0;
    await this.platform.uart.switchCrownstone(this.uid, percentage);

    this.state.On = percentage > 0;
    const cloudStone = await this.platform.cloud.crownstone(this.id);
    await cloudStone.setCurrentSwitchState(percentage);
  }
}
