import { zKey } from "snarkjs"
import fs from "fs"
import path from "path"
import { cwd } from "process"

/**
 * Helper method to extract the Solidity verifier
 * from a final zKey file and save it to a local file.
 * @param solidityVersion <string> The solidity version to include in the verifier pragma definition.
 * @param finalZkeyPath <string> The path to the zKey file.
 * @param verifierLocalPath <string> The path to the local file where the verifier will be saved.
 */
export const exportVerifierContract = async (
    solidityVersion: string,
    finalZkeyPath: string,
    verifierLocalPath: string
) => {
    // Extract verifier.

    let verifierCode = await zKey.exportSolidityVerifier(
        finalZkeyPath,
        {
            groth16: fs
                .readFileSync(path.join(cwd(), "node_modules/snarkjs/templates/verifier_groth16.sol.ejs"))
                .toString()
        },
        console
    )

    // Update solidity version.
    verifierCode = verifierCode.replace(
        /pragma solidity \^\d+\.\d+\.\d+/,
        `pragma solidity ^${solidityVersion || "0.8.0"}`
    )

    fs.writeFileSync(verifierLocalPath, verifierCode)
}

/**
 * Helpers method to extract the vKey from a final zKey file
 * @param finalZkeyPath <string> The path to the zKey file.
 * @param vKeyLocalPath <string> The path to the local file where the vKey will be saved.
 */
export const exportVkey = async (finalZkeyPath: string, vKeyLocalPath: string) => {
    const verificationKeyJSONData = await zKey.exportVerificationKey(finalZkeyPath)
    fs.writeFileSync(vKeyLocalPath, JSON.stringify(verificationKeyJSONData))
}

/**
 * Helper method to extract the Solidity verifier and the Verification key
 * from a final zKey file and save them to local files.
 * @param solidityVersion <string> The solidity version to include in the verifier pragma definition.
 * @param finalZkeyPath <string> The path to the zKey file.
 * @param verifierLocalPath <string> The path to the local file where the verifier will be saved.
 * @param vKeyLocalPath <string> The path to the local file where the vKey will be saved.
 */
export const exportVerifierAndVKey = async (
    solidityVersion: string,
    finalZkeyPath: string,
    verifierLocalPath: string,
    vKeyLocalPath: string
) => {
    await exportVerifierContract(solidityVersion, finalZkeyPath, verifierLocalPath)
    await exportVkey(finalZkeyPath, vKeyLocalPath)
}
