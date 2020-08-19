import Q = require('q');
import path = require("path");
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import TaskParameters from "./TaskParameters";
import { NullOutstreamStringWritable, getCurrentTime } from "./Utils";
import ImageBuilderClient from "./AzureImageBuilderClient";
import BuildTemplate from "./BuildTemplate";
import { IAuthorizer } from 'azure-actions-webclient/Authorizer/IAuthorizer';
import Util = require('util');
import Utils from "./Utils";
var fs = require('fs');
var archiver = require('archiver');
import * as constants from "./constants";
import { WebRequest } from 'azure-actions-webclient/WebClient';
import { ServiceClient as AzureRestClient } from 'azure-actions-webclient/AzureRestClient';
var azure = require('azure-storage');

var azPath: string;
var roleDefinitionExists: boolean = false;
var managedIdentityExists: boolean = false;
var roleAssignmentForManagedIdentityExists: boolean = false;
var storageAccountExists: boolean = false;
var roleAssignmentForStorageAccountExists: boolean = false;
export default class ImageBuilder {

    private _taskParameters: TaskParameters;
    private _aibClient: ImageBuilderClient;
    private _buildTemplate: BuildTemplate;
    private _blobService: any;
    private resourceAuthorizer: IAuthorizer;
    private _client: AzureRestClient;

    constructor(resourceAuthorizer: IAuthorizer) {
        try {
            this.resourceAuthorizer = resourceAuthorizer;
            this._taskParameters = new TaskParameters();
            this._buildTemplate = new BuildTemplate(resourceAuthorizer, this._taskParameters);
            this._aibClient = new ImageBuilderClient(resourceAuthorizer, this._taskParameters);
            this._client = new AzureRestClient(resourceAuthorizer);
        }
        catch (error) {
            throw (`error happened while initializing Image builder: ${error}`);
        }
    }

    async execute() {
        var isVhdDistribute: boolean = false;
        var templateName: string = "";
        var storageAccount: string = "";
        var containerName: string = "";
        var principalId = "";
        var idenityName: string = "";
        var imageRoleDefName: string = "";
        var imgBuilderTemplateExists: boolean = false;
        var accountkeys: string = "";
        try {
            azPath = await io.which("az", true);
            var outStream = '';
            await this.executeAzCliCommand("--version");
            //Register all features for Azure Image Builder Service
            outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
            if (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).properties.state, "Registered")) {
                console.log("Register Microsoft.VirtualMachineImages");
                await this.executeAzCliCommand("feature register --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview");
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
                while (!Utils.IsEqual(JSON.parse(`${outStream}`).properties.state, "Registered")) {
                    outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
                }
            }
            outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
            if (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).properties.state, "Registered")) {
                await this.executeAzCliCommand("provider register -n Microsoft.VirtualMachineImages");
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
                while (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).properties.state, "Registered")) {
                    outStream = await this.executeAzCliCommand(`feature show --namespace Microsoft.VirtualMachineImages --name VirtualMachineTemplatePreview`);
                }
            }
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
            if (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).registrationState, "Registered")) {
                console.log("Register Microsoft.Storage");
                await this.executeAzCliCommand("provider register -n Microsoft.Storage");
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
                while (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).registrationState, "Registered")) {
                    outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Storage`);
                }
            }
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
            if (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).registrationState, "Registered")) {
                console.log("Register Microsoft.Compute");
                await this.executeAzCliCommand("provider register -n Microsoft.Compute");
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
                while (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).registrationState, "Registered")) {
                    outStream = await this.executeAzCliCommand(`provider show -n Microsoft.Compute`);
                }
            }
            outStream = await this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
            if (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).registrationState, "Registered")) {
                console.log("Register Microsoft.KeyVault");
                await this.executeAzCliCommand("provider register -n Microsoft.KeyVault");
                this.sleepFor(1);
                outStream = await this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
                while (JSON.parse(`${outStream}`) && !Utils.IsEqual(JSON.parse(`${outStream}`).registrationState, "Registered")) {
                    outStream = await this.executeAzCliCommand(`provider show -n Microsoft.KeyVault`);
                }
            }

            this.sleepFor(2);

            //GENERAL INPUTS
            outStream = await this.executeAzCliCommand("account show");
            var subscriptionId = JSON.parse(`${outStream}`).id.toString();

            if (this._taskParameters.resourceGroupName == null || this._taskParameters.resourceGroupName == undefined || this._taskParameters.resourceGroupName.length == 0) {
                var resourceGroupName = Util.format('%s%s', constants.resourceGroupName, getCurrentTime());
                this._taskParameters.resourceGroupName = resourceGroupName;
                await this.executeAzCliCommand(`group create -n ${resourceGroupName} -l ${this._taskParameters.location}`);
                console.log("resource group " + resourceGroupName + " got created");
            }

            //template json for role definition 
            imageRoleDefName = "aibImageDef" + getCurrentTime();
            var templateRoleDefinition = `{
                    "Name": "${imageRoleDefName}",
                    "IsCustom": true,
                    "Description": "Image Builder access to create resources for the image build, you should delete or spit out as appropriate",
                    "Actions": [
                        "Microsoft.Compute/galleries/read",
                        "Microsoft.Compute/galleries/images/read",
                        "Microsoft.Compute/galleries/images/versions/read",
                        "Microsoft.Compute/galleries/images/versions/write",
                
                        "Microsoft.Compute/images/write",
                        "Microsoft.Compute/images/read",
                        "Microsoft.Compute/images/delete"
                    ],
                    "NotActions": [
                  
                    ],
                    "AssignableScopes": [
                        "/subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}"
                    ]
                  }`;

            var templateJsonRoleDefinition = JSON.parse(templateRoleDefinition);
            fs.writeFileSync('./src/template.json', JSON.stringify(templateJsonRoleDefinition));

            //create image role defintion 
            await this.executeAzCliCommand(`role definition create --role-definition ./src/template.json`);
            console.log("role definition " + imageRoleDefName + " got created");
            roleDefinitionExists = true;
            await this.sleepFor(20);

            //create managed identity
            var imgBuilderId = "";
            idenityName = Util.format('%s%s', constants.identityName, getCurrentTime());
            outStream = await this.executeAzCliCommand(`identity create -n ${idenityName} -g ${this._taskParameters.resourceGroupName} -l ${this._taskParameters.location}`);
            imgBuilderId = `/subscriptions/${subscriptionId}/resourcegroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${idenityName}`;
            principalId = JSON.parse(`${outStream}`).principalId.toString();
            console.log("managed identity" + idenityName + " got created");
            managedIdentityExists = true;
            await this.sleepFor(20);
            //create role assignment for managed identity
            await this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`);
            console.log("role assignment for managed identity" + idenityName + " got created");
            roleAssignmentForManagedIdentityExists = true;

            //CUSTOMIZER INPUTS
            storageAccount = Util.format('%s%s', constants.storageAccountName, getCurrentTime());
            await this.executeAzCliCommand(`storage account create --name "${storageAccount}" --resource-group "${this._taskParameters.resourceGroupName}" --location "${this._taskParameters.location}" --sku Standard_RAGRS`);
            await this.sleepFor(20);
            outStream = await this.executeAzCliCommand(`storage account keys list -g "${this._taskParameters.resourceGroupName}" -n "${storageAccount}"`);
            accountkeys = JSON.parse(`${outStream}`)[0].value;
            console.log("storage account " + storageAccount + " got created");
            storageAccountExists = true;

            //create a blob service
            this._blobService = azure.createBlobService(storageAccount, accountkeys);
            containerName = constants.containerName;
            var blobName: string = this._taskParameters.buildFolder + "/" + this._taskParameters.buildFolder + `_${getCurrentTime()}`;
            if (Utils.IsEqual(this._taskParameters.provisioner, "powershell"))
                blobName = blobName + '.zip';
            else
                blobName = blobName + '.tar.gz';
            var blobUrl = await this.uploadPackage(containerName, blobName);
            await this.sleepFor(20);
            await this.executeAzCliCommand(`role assignment create --assignee-object-id ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`)
            console.log("role assignment for storage account " + storageAccount + " got created");
            roleAssignmentForStorageAccountExists = true;

            //create template
            console.log("template creation");
            var templateJson = await this._buildTemplate.getTemplate(blobUrl, imgBuilderId, subscriptionId);
            templateName = this.getTemplateName();
            var runOutputName = this._taskParameters.runOutputName;
            if (runOutputName == null || runOutputName == undefined || runOutputName.length == 0) {
                runOutputName = templateJson.properties.distribute[0].runOutputName;
            }
            isVhdDistribute = templateJson.properties.distribute[0].type == "VHD";

            var templateStr = JSON.stringify(templateJson);
            console.log("Image Template JSON" + templateStr);
            await this._aibClient.putImageTemplate(templateStr, templateName, subscriptionId);
            imgBuilderTemplateExists = true;
            await this._aibClient.runTemplate(templateName, subscriptionId, this._taskParameters.buildTimeoutInMinutes);
            var out = await this._aibClient.getRunOutput(templateName, runOutputName, subscriptionId);
            var templateID = await this._aibClient.getTemplateId(templateName, subscriptionId);
            core.setOutput(runOutputName, templateName);
            core.setOutput('templateId', templateID);
            if (out) {
                core.setOutput('customImageURI', out);
                core.setOutput('imagebuilderRunStatus', "succeeded");
            }

            if (Utils.IsEqual(templateJson.properties.source.type, "PlatformImage")) {
                core.setOutput('pirPublisher', templateJson.properties.source.publisher);
                core.setOutput('pirOffer', templateJson.properties.source.offer);
                core.setOutput('pirSku', templateJson.properties.source.sku);
                core.setOutput('pirVersion', templateJson.properties.source.version);
            }

            console.log("==============================================================================")
            console.log("## task output variables ##");
            console.log("$(imageUri) = ", out);
            if (isVhdDistribute) {
                console.log("$(templateName) = ", templateName);
                console.log("$(templateId) = ", templateID);
            }
            console.log("==============================================================================")

        }
        catch (error) {
            throw error;
        }
        finally {
            var outStream = await this.executeAzCliCommand(`group exists -n ${this._taskParameters.resourceGroupName}`);
            if (outStream) {
                this.cleanup(isVhdDistribute, templateName, imgBuilderTemplateExists, subscriptionId, storageAccount, containerName, accountkeys, idenityName, principalId, imageRoleDefName);
            }
        }
    }

    private getTemplateName() {
        if (this._taskParameters.imagebuilderTemplateName) {
            return this._taskParameters.imagebuilderTemplateName
        }
        return constants.imageTemplateName + getCurrentTime();
    }

    private async uploadPackage(containerName: string, blobName: string): Promise<string> {

        var defer = Q.defer<string>();
        var archivedWebPackage: any;
        var temp = this._generateTemporaryFile(`${process.env.GITHUB_WORKSPACE}`);
        try {
            if (Utils.IsEqual(this._taskParameters.provisioner, "powershell")) {
                temp = temp + `.zip`;
                archivedWebPackage = await this.createArchiveTar(this._taskParameters.buildPath, temp, "zip");
            }
            else {
                temp = temp + `.tar.gz`;
                archivedWebPackage = await this.createArchiveTar(this._taskParameters.buildPath, temp, "tar");
            }
        }
        catch (error) {
            defer.reject(console.log(`unable to create archive build: ${error}`));
        }
        console.log(`created  archive ` + archivedWebPackage);

        this._blobService.createContainerIfNotExists(containerName, (error: any) => {
            if (error) {
                defer.reject(console.log(`unable to create container ${containerName} in storage account: ${error}`));
            }

            //upoading package
            this._blobService.createBlockBlobFromLocalFile(containerName, blobName, archivedWebPackage, (error: any, result: any) => {
                if (error) {
                    defer.reject(console.log(`unable to create blob ${blobName} in container ${containerName} in storage account: ${error}`));
                }
                //generating SAS URL
                var startDate = new Date();
                var expiryDate = new Date(startDate);
                expiryDate.setFullYear(startDate.getUTCFullYear() + 1);
                startDate.setMinutes(startDate.getMinutes() - 5);

                var sharedAccessPolicy = {
                    AccessPolicy: {
                        Permissions: azure.BlobUtilities.SharedAccessPermissions.READ,
                        Start: startDate,
                        Expiry: expiryDate
                    }
                };

                var token = this._blobService.generateSharedAccessSignature(containerName, blobName, sharedAccessPolicy);
                var blobUrl = this._blobService.getUrl(containerName, blobName, token);
                defer.resolve(blobUrl);
            });
        });
        return defer.promise;
    }

    public async createArchiveTar(folderPath: string, targetPath: string, extension: string) {
        var defer = Q.defer();
        console.log('Archiving ' + folderPath + ' to ' + targetPath);
        var output = fs.createWriteStream(targetPath);
        var archive: any;

        if (Utils.IsEqual(extension, 'zip')) {
            archive = archiver('zip', { zlib: { level: 9 } });
        }
        else {
            archive = archiver('tar', {
                gzip: true,
                gzipOptions: {
                    level: 1
                }
            });
        }

        output.on('close', function () {
            console.log(archive.pointer() + ' total bytes');
            core.debug('Successfully created archive ' + targetPath);
            defer.resolve(targetPath);
        });

        output.on('error', function (error: any) {
            defer.reject(error);
        });

        archive.glob("**", {
            cwd: folderPath,
            dot: true
        });
        archive.pipe(output);
        archive.finalize();

        return defer.promise;
    }

    private _generateTemporaryFile(folderPath: string): string {
        var randomString = Math.random().toString().split('.')[1];
        var tempPath = path.join(folderPath, '/temp_web_package_' + randomString);
        return tempPath;
    }

    private async cleanup(isVhdDistribute: boolean, templateName: string, imgBuilderTemplateExists: boolean, subscriptionId: string, storageAccount: string, containerName: string, accountkeys: string, idenityName: string, principalId: string, imageRoleDefName: string) {
        try {
            if (!isVhdDistribute && imgBuilderTemplateExists) {
                await this._aibClient.deleteTemplate(templateName, subscriptionId);
                console.log(`${templateName} got deleted`);
            }
            if (roleAssignmentForStorageAccountExists) {
                await this.executeAzCliCommand(`role assignment delete --assignee ${principalId} --role "Storage Blob Data Reader" --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccount}/blobServices/default/containers/${containerName}`);
                console.log("role assignment for storage account deleted");
            }
            if (storageAccountExists) {
                let httpRequest: WebRequest = {
                    method: 'DELETE',
                    uri: this._client.getRequestUri(`subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Storage/storageAccounts/{storageAccount}`, { '{subscriptionId}': subscriptionId, '{resourceGroupName}': this._taskParameters.resourceGroupName, '{storageAccount}': storageAccount }, [], "2019-06-01")
                };
                var response = await this._client.beginRequest(httpRequest);
                console.log("storage account " + storageAccount + " deleted");
            }
            if (roleAssignmentForManagedIdentityExists) {
                await this.executeAzCliCommand(`role assignment delete --assignee ${principalId} --role ${imageRoleDefName} --scope /subscriptions/${subscriptionId}/resourceGroups/${this._taskParameters.resourceGroupName}`);
                console.log("role assignment deleted");
            }
            if (managedIdentityExists) {
                await this.executeAzCliCommand(`identity delete -n ${idenityName} -g ${this._taskParameters.resourceGroupName}`);
                console.log(`identity ${idenityName} +deleted`);
            }
            if (roleDefinitionExists) {
                await this.executeAzCliCommand(`role definition delete --name ${imageRoleDefName}`);
                console.log(`role definition ${imageRoleDefName} deleted`);
            }
        }
        catch (error) {
            console.log(`Error in cleanup: `, error);
        }
    }

    async executeAzCliCommand(command: string, options?: any): Promise<string> {
        var outStream: string = '';
        var execOptions: any = {
            outStream: new NullOutstreamStringWritable({ decodeStrings: false }),
            listeners: {
                stdout: (data: any) => outStream += data.toString(),
            }
        };
        try {
            await exec.exec(`"${azPath}" ${command}`, [], execOptions);
            //console.log(outStream);
            return outStream;
        }
        catch (error) {
            console.log(JSON.stringify(error));
            throw error;
        }
    }

    private sleepFor(sleepDurationInSeconds: any): Promise<any> {
        return new Promise((resolve, reeject) => {
            console.log("sleeping for " + sleepDurationInSeconds);
            setTimeout(resolve, sleepDurationInSeconds * 1000);
            console.log("sleeping for " + sleepDurationInSeconds);
        });
    }
}