//
//  BridgeViewController.swift
//  Gym Tracker
//
//  Capacitor bridge subclass whose only job is registering the in-app
//  HealthKit plugin. Main.storyboard points its single view controller at this
//  class (customModule "App"), so the plugin is available to the webview from
//  the moment the bridge loads.
//

import Capacitor
import UIKit

class BridgeViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HealthKitPlugin())
    }
}
