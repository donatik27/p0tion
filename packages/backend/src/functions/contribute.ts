import * as functions from "firebase-functions"
import admin from "firebase-admin"
import dotenv from "dotenv"
import {
    commonTerms,
    getCircuitsCollectionPath,
    getParticipantsCollectionPath,
    getTimeoutsCollectionPath
} from "@zkmpc/actions/src"
import {
    CeremonyState,
    ParticipantStatus,
    ParticipantContributionStep,
    CeremonyTimeoutType,
    TimeoutType
} from "@zkmpc/actions/src/types/enums"
import { MsgType } from "../../types/enums"
import { GENERIC_ERRORS, GENERIC_LOGS, logMsg } from "../lib/logs"
import {
    getCeremonyCircuits,
    getCurrentServerTimestampInMillis,
    getParticipantById,
    queryCeremoniesByStateAndDate,
    queryValidTimeoutsByDate
} from "../lib/utils"

dotenv.config()

/**
 * Check if a user can participate for the given ceremony (e.g., new contributor, after timeout expiration, etc.).
 */
export const checkParticipantForCeremony = functions.https.onCall(
    async (data: any, context: functions.https.CallableContext) => {
        // Check if sender is authenticated.
        if (!context.auth || (!context.auth.token.participant && !context.auth.token.coordinator))
            logMsg(GENERIC_ERRORS.GENERR_NO_AUTH_USER_FOUND, MsgType.ERROR)

        if (!data.ceremonyId) logMsg(GENERIC_ERRORS.GENERR_NO_CEREMONY_PROVIDED, MsgType.ERROR)

        // Get DB.
        const firestore = admin.firestore()

        // Get data.
        const { ceremonyId } = data
        const userId = context.auth?.uid

        // Look for the ceremony.
        const ceremonyDoc = await firestore.collection(commonTerms.collections.ceremonies.name).doc(ceremonyId).get()

        // Check existence.
        if (!ceremonyDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)

        // Get ceremony data.
        const ceremonyData = ceremonyDoc.data()

        // Check if running.
        if (!ceremonyData || ceremonyData.state !== CeremonyState.OPENED)
            logMsg(GENERIC_ERRORS.GENERR_CEREMONY_NOT_OPENED, MsgType.ERROR)

        // Look for the user among ceremony participants.
        console.log(userId)
        console.log(ceremonyId)
        const participantDoc = await firestore.collection(getParticipantsCollectionPath(ceremonyId)).doc(userId!).get()
        logMsg(`Participant document ${participantDoc.exists}`, MsgType.DEBUG)

        if (!participantDoc.exists) {
            // Create a new Participant doc for the sender.
            await participantDoc.ref.set({
                status: ParticipantStatus.WAITING,
                contributionProgress: 0,
                contributions: [],
                lastUpdated: getCurrentServerTimestampInMillis()
            })

            logMsg(`User ${userId} has been registered as participant for ceremony ${ceremonyDoc.id}`, MsgType.INFO)
        } else {
            // Check if the participant has completed the contributions for all circuits.
            const participantData = participantDoc.data()
            console.log(participantData)

            if (!participantData) logMsg(GENERIC_ERRORS.GENERR_NO_DATA, MsgType.ERROR)

            logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

            const circuits = await getCeremonyCircuits(getCircuitsCollectionPath(ceremonyDoc.id))

            logMsg(circuits.toString(), MsgType.DEBUG)

            // Already contributed to all circuits or currently contributor without any timeout.
            if (
                participantData?.contributionProgress === circuits.length &&
                participantData?.status === ParticipantStatus.DONE
            ) {
                logMsg(
                    `Participant ${participantDoc.id} has already contributed to all circuits or is the current contributor to that circuit (no timed out yet)`,
                    MsgType.DEBUG
                )

                return false
            }
            console.log(participantData)
            if (participantData?.status === ParticipantStatus.TIMEDOUT) {
                // Get `valid` timeouts (i.e., endDate is not expired).
                const validTimeoutsQuerySnap = await queryValidTimeoutsByDate(
                    ceremonyDoc.id,
                    participantDoc.id,
                    commonTerms.collections.timeouts.fields.endDate
                )

                if (validTimeoutsQuerySnap.empty) {
                    // @todo need to remove unstable contributions (only one without doc link) and temp data, contributor must restart from step 1.
                    // The participant can retry the contribution.
                    await participantDoc.ref.set(
                        {
                            status: ParticipantStatus.EXHUMED,
                            contributionStep: ParticipantContributionStep.DOWNLOADING,
                            lastUpdated: getCurrentServerTimestampInMillis()
                        },
                        { merge: true }
                    )

                    logMsg(`Participant ${participantDoc.id} can retry the contribution from right now`, MsgType.DEBUG)
                    return true
                }
                logMsg(`Participant ${participantDoc.id} cannot retry the contribution yet`, MsgType.DEBUG)

                return false
            }
        }

        return true
    }
)

/**
 * Check and remove the current contributor who is taking more than a specified amount of time for completing the contribution.
 */
export const checkAndRemoveBlockingContributor = functions.pubsub.schedule("every 1 minutes").onRun(async () => {
    // Get DB.
    const firestore = admin.firestore()
    const currentDate = getCurrentServerTimestampInMillis()

    // Get ceremonies in `opened` state.
    const openedCeremoniesQuerySnap = await queryCeremoniesByStateAndDate(
        CeremonyState.OPENED,
        commonTerms.collections.ceremonies.fields.endDate,
        ">="
    )

    if (openedCeremoniesQuerySnap.empty) logMsg(GENERIC_ERRORS.GENERR_NO_CEREMONIES_OPENED, MsgType.ERROR)

    // For each ceremony.
    for (const ceremonyDoc of openedCeremoniesQuerySnap.docs) {
        if (!ceremonyDoc.exists || !ceremonyDoc.data()) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)

        logMsg(`Ceremony document ${ceremonyDoc.id} okay`, MsgType.DEBUG)

        // Get data.
        const { timeoutType: ceremonyTimeoutType, penalty } = ceremonyDoc.data()

        // Get circuits.
        const circuitsDocs = await getCeremonyCircuits(getCircuitsCollectionPath(ceremonyDoc.id))

        // For each circuit.
        for (const circuitDoc of circuitsDocs) {
            if (!circuitDoc.exists || !circuitDoc.data()) logMsg(GENERIC_ERRORS.GENERR_INVALID_CIRCUIT, MsgType.ERROR)

            const circuitData = circuitDoc.data()

            logMsg(`Circuit document ${circuitDoc.id} okay`, MsgType.DEBUG)

            // Get data.
            const { waitingQueue, avgTimings } = circuitData
            const { contributors, currentContributor, failedContributions, completedContributions } = waitingQueue
            const { fullContribution: avgFullContribution } = avgTimings

            // Check for current contributor.
            if (!currentContributor) logMsg(GENERIC_ERRORS.GENERR_NO_CURRENT_CONTRIBUTOR, MsgType.WARN)

            // Check if first contributor.
            if (
                !currentContributor &&
                avgFullContribution === 0 &&
                completedContributions === 0 &&
                ceremonyTimeoutType === CeremonyTimeoutType.DYNAMIC
            )
                logMsg(GENERIC_ERRORS.GENERR_NO_TIMEOUT_FIRST_COTRIBUTOR, MsgType.DEBUG)

            if (
                !!currentContributor &&
                ((avgFullContribution > 0 && completedContributions > 0) ||
                    ceremonyTimeoutType === CeremonyTimeoutType.FIXED)
            ) {
                // Get current contributor data (i.e., participant).
                const participantDoc = await getParticipantById(ceremonyDoc.id, currentContributor)

                if (!participantDoc.exists || !participantDoc.data())
                    logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT, MsgType.WARN)
                else {
                    const participantData = participantDoc.data()
                    const contributionStartedAt = participantData?.contributionStartedAt
                    const verificationStartedAt = participantData?.verificationStartedAt
                    const currentContributionStep = participantData?.contributionStep

                    logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

                    // Check for blocking contributions (frontend-side).
                    const timeoutToleranceThreshold =
                        ceremonyTimeoutType === CeremonyTimeoutType.DYNAMIC
                            ? (avgFullContribution / 100) * Number(circuitData.dynamicThreshold)
                            : 0

                    const timeoutExpirationDateInMillisForBlockingContributor =
                        ceremonyTimeoutType === CeremonyTimeoutType.DYNAMIC
                            ? Number(contributionStartedAt) +
                              Number(avgFullContribution) +
                              Number(timeoutToleranceThreshold)
                            : Number(contributionStartedAt) + Number(circuitData.fixedTimeWindow) * 60000 // * 60000 = to convert millis in minutes.

                    logMsg(`Contribution start date ${contributionStartedAt}`, MsgType.DEBUG)
                    if (ceremonyTimeoutType === CeremonyTimeoutType.DYNAMIC) {
                        logMsg(`Average contribution per circuit time ${avgFullContribution} ms`, MsgType.DEBUG)
                        logMsg(`Timeout tolerance threshold set to ${timeoutToleranceThreshold}`, MsgType.DEBUG)
                    }
                    logMsg(
                        `BC Timeout expirartion date ${timeoutExpirationDateInMillisForBlockingContributor} ms`,
                        MsgType.DEBUG
                    )

                    // Check for blocking verifications (backend-side).
                    const timeoutExpirationDateInMillisForBlockingFunction = !verificationStartedAt
                        ? 0
                        : Number(verificationStartedAt) + 3540000 // 3540000 = 59 minutes in ms.

                    logMsg(`Verification start date ${verificationStartedAt}`, MsgType.DEBUG)
                    logMsg(
                        `CF Timeout expirartion date ${timeoutExpirationDateInMillisForBlockingFunction} ms`,
                        MsgType.DEBUG
                    )

                    // Get timeout type.
                    let timeoutType: string = ""

                    if (
                        timeoutExpirationDateInMillisForBlockingContributor < currentDate &&
                        (currentContributionStep === ParticipantContributionStep.DOWNLOADING ||
                            currentContributionStep === ParticipantContributionStep.COMPUTING ||
                            currentContributionStep === ParticipantContributionStep.UPLOADING)
                    )
                        timeoutType = TimeoutType.BLOCKING_CONTRIBUTION

                    if (
                        timeoutExpirationDateInMillisForBlockingFunction > 0 &&
                        timeoutExpirationDateInMillisForBlockingFunction < currentDate &&
                        currentContributionStep === ParticipantContributionStep.VERIFYING
                    )
                        timeoutType = TimeoutType.BLOCKING_CLOUD_FUNCTION

                    logMsg(`Ceremony Timeout type ${ceremonyTimeoutType}`, MsgType.DEBUG)
                    logMsg(`Timeout type ${timeoutType}`, MsgType.DEBUG)

                    // Check if one timeout should be triggered.
                    if (
                        timeoutType === TimeoutType.BLOCKING_CLOUD_FUNCTION ||
                        timeoutType === TimeoutType.BLOCKING_CONTRIBUTION
                    ) {
                        // Timeout the participant.
                        const batch = firestore.batch()

                        // 1. Update circuit' waiting queue.
                        contributors.shift(1)

                        let newCurrentContributor = ""

                        if (contributors.length > 0) {
                            // There's someone else ready to contribute.
                            newCurrentContributor = contributors.at(0)

                            // Pass the baton to the next participant.
                            const newCurrentContributorDoc = await firestore
                                .collection(getParticipantsCollectionPath(ceremonyDoc.id))
                                .doc(newCurrentContributor)
                                .get()

                            if (newCurrentContributorDoc.exists) {
                                batch.update(newCurrentContributorDoc.ref, {
                                    status: ParticipantStatus.WAITING,
                                    lastUpdated: getCurrentServerTimestampInMillis()
                                })
                            }
                        }

                        batch.update(circuitDoc.ref, {
                            waitingQueue: {
                                ...circuitData.waitingQueue,
                                contributors,
                                currentContributor: newCurrentContributor,
                                failedContributions: failedContributions + 1
                            },
                            lastUpdated: getCurrentServerTimestampInMillis()
                        })

                        logMsg(`Batch: update for circuit' waiting queue`, MsgType.DEBUG)

                        // 2. Change blocking contributor status.
                        batch.update(participantDoc.ref, {
                            status: ParticipantStatus.TIMEDOUT,
                            lastUpdated: getCurrentServerTimestampInMillis()
                        })

                        logMsg(`Batch: change blocking contributor status to TIMEDOUT`, MsgType.DEBUG)

                        // 3. Create a new collection of timeouts (to keep track of participants timeouts).
                        const retryWaitingTimeInMillis = Number(penalty) * 60000 // 60000 = amount of ms x minute.

                        // Timeout collection.
                        const timeoutDoc = await firestore
                            .collection(getTimeoutsCollectionPath(ceremonyDoc.id, participantDoc.id))
                            .doc()
                            .get()

                        batch.create(timeoutDoc.ref, {
                            type: timeoutType,
                            startDate: currentDate,
                            endDate: currentDate + retryWaitingTimeInMillis
                        })

                        logMsg(`Batch: add timeout document for blocking contributor`, MsgType.DEBUG)

                        await batch.commit()

                        logMsg(`Blocking contributor ${participantDoc.id} timedout. Cause ${timeoutType}`, MsgType.INFO)
                    } else logMsg(GENERIC_LOGS.GENLOG_NO_TIMEOUT, MsgType.INFO)
                }
            }
        }
    }
})

/**
 * Progress to next contribution step for the current contributor of a specified circuit in a given ceremony.
 */
export const progressToNextContributionStep = functions.https.onCall(
    async (data: any, context: functions.https.CallableContext) => {
        // Check if sender is authenticated.
        if (!context.auth || (!context.auth.token.participant && !context.auth.token.coordinator))
            logMsg(GENERIC_ERRORS.GENERR_NO_AUTH_USER_FOUND, MsgType.ERROR)

        if (!data.ceremonyId) logMsg(GENERIC_ERRORS.GENERR_NO_CEREMONY_PROVIDED, MsgType.ERROR)

        // Get DB.
        const firestore = admin.firestore()

        // Get data.
        const { ceremonyId } = data
        const userId = context.auth?.uid

        // Look for the ceremony.
        const ceremonyDoc = await firestore.collection(commonTerms.collections.ceremonies.name).doc(ceremonyId).get()

        // Check existence.
        if (!ceremonyDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)

        // Get ceremony data.
        const ceremonyData = ceremonyDoc.data()

        // Check if running.
        if (!ceremonyData || ceremonyData.state !== CeremonyState.OPENED)
            logMsg(GENERIC_ERRORS.GENERR_CEREMONY_NOT_OPENED, MsgType.ERROR)

        logMsg(`Ceremony document ${ceremonyId} okay`, MsgType.DEBUG)

        // Look for the user among ceremony participants.
        const participantDoc = await firestore
            .collection(getParticipantsCollectionPath(ceremonyDoc.id))
            .doc(userId!)
            .get()

        // Check existence.
        if (!participantDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT, MsgType.ERROR)

        // Get participant data.
        const participantData = participantDoc.data()

        if (!participantData) logMsg(GENERIC_ERRORS.GENERR_NO_DATA, MsgType.ERROR)

        logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

        // Check if participant is able to advance to next contribution step.
        if (participantData?.status !== ParticipantStatus.CONTRIBUTING)
            logMsg(`Participant ${participantDoc.id} is not contributing`, MsgType.ERROR)

        // Make the advancement.
        let progress: string = ""

        if (participantData?.contributionStep === ParticipantContributionStep.DOWNLOADING)
            progress = ParticipantContributionStep.COMPUTING
        if (participantData?.contributionStep === ParticipantContributionStep.COMPUTING)
            progress = ParticipantContributionStep.UPLOADING
        if (participantData?.contributionStep === ParticipantContributionStep.UPLOADING)
            progress = ParticipantContributionStep.VERIFYING
        if (participantData?.contributionStep === ParticipantContributionStep.VERIFYING)
            progress = ParticipantContributionStep.COMPLETED

        logMsg(`Current contribution step should be ${participantData?.contributionStep}`, MsgType.DEBUG)
        logMsg(`Next contribution step should be ${progress}`, MsgType.DEBUG)

        if (progress === ParticipantContributionStep.VERIFYING)
            await participantDoc.ref.update({
                contributionStep: progress,
                verificationStartedAt: getCurrentServerTimestampInMillis(),
                lastUpdated: getCurrentServerTimestampInMillis()
            })
        else
            await participantDoc.ref.update({
                contributionStep: progress,
                lastUpdated: getCurrentServerTimestampInMillis()
            })
    }
)

/**
 * Temporary store the contribution computation time for the current contributor.
 */
export const temporaryStoreCurrentContributionComputationTime = functions.https.onCall(
    async (data: any, context: functions.https.CallableContext) => {
        // Check if sender is authenticated.
        if (!context.auth || (!context.auth.token.participant && !context.auth.token.coordinator))
            logMsg(GENERIC_ERRORS.GENERR_NO_AUTH_USER_FOUND, MsgType.ERROR)

        if (!data.ceremonyId || data.contributionComputationTime <= 0)
            logMsg(GENERIC_ERRORS.GENERR_MISSING_INPUT, MsgType.ERROR)

        // Get DB.
        const firestore = admin.firestore()

        // Get data.
        const { ceremonyId } = data
        const userId = context.auth?.uid

        // Look for documents.
        const ceremonyDoc = await firestore.collection(commonTerms.collections.ceremonies.name).doc(ceremonyId).get()
        const participantDoc = await firestore
            .collection(getParticipantsCollectionPath(ceremonyDoc.id))
            .doc(userId!)
            .get()

        // Check existence.
        if (!ceremonyDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)
        if (!participantDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT, MsgType.ERROR)

        // Get data.
        const participantData = participantDoc.data()

        if (!participantData) logMsg(GENERIC_ERRORS.GENERR_NO_DATA, MsgType.ERROR)

        logMsg(`Ceremony document ${ceremonyId} okay`, MsgType.DEBUG)
        logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

        // Check if has reached the computing step while contributing.
        if (participantData?.contributionStep !== ParticipantContributionStep.COMPUTING)
            logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT_CONTRIBUTION_STEP, MsgType.ERROR)

        // Update.
        await participantDoc.ref.set(
            {
                ...participantData!,
                tempContributionData: {
                    contributionComputationTime: data.contributionComputationTime
                },
                lastUpdated: getCurrentServerTimestampInMillis()
            },
            { merge: true }
        )
    }
)

/**
 * Permanently store the contribution computation hash for attestation generation for the current contributor.
 */
export const permanentlyStoreCurrentContributionTimeAndHash = functions.https.onCall(
    async (data: any, context: functions.https.CallableContext) => {
        // Check if sender is authenticated.
        if (!context.auth || (!context.auth.token.participant && !context.auth.token.coordinator))
            logMsg(GENERIC_ERRORS.GENERR_NO_AUTH_USER_FOUND, MsgType.ERROR)

        if (!data.ceremonyId || data.contributionComputationTime <= 0 || !data.contributionHash)
            logMsg(GENERIC_ERRORS.GENERR_MISSING_INPUT, MsgType.ERROR)

        // Get DB.
        const firestore = admin.firestore()

        // Get data.
        const { ceremonyId } = data
        const userId = context.auth?.uid

        // Look for documents.
        const ceremonyDoc = await firestore.collection(commonTerms.collections.ceremonies.name).doc(ceremonyId).get()
        const participantDoc = await firestore.collection(getParticipantsCollectionPath(ceremonyId)).doc(userId!).get()

        // Check existence.
        if (!ceremonyDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)
        if (!participantDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT, MsgType.ERROR)

        // Get data.
        const participantData = participantDoc.data()

        if (!participantData) logMsg(GENERIC_ERRORS.GENERR_NO_DATA, MsgType.ERROR)

        logMsg(`Ceremony document ${ceremonyId} okay`, MsgType.DEBUG)
        logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

        // Check if has reached the computing step while contributing or is finalizing.
        if (
            participantData?.contributionStep === ParticipantContributionStep.COMPUTING ||
            (context?.auth?.token.coordinator && participantData?.status === ParticipantStatus.FINALIZING)
        )
            // Update.
            await participantDoc.ref.set(
                {
                    ...participantData!,
                    contributions: [
                        ...participantData!.contributions,
                        {
                            hash: data.contributionHash!,
                            computationTime: data.contributionComputationTime
                        }
                    ],
                    lastUpdated: getCurrentServerTimestampInMillis()
                },
                { merge: true }
            )
        else logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT_CONTRIBUTION_STEP, MsgType.ERROR)
    }
)

/**
 * Temporary store the the Multi-Part Upload identifier for the current contributor.
 */
export const temporaryStoreCurrentContributionMultiPartUploadId = functions.https.onCall(
    async (data: any, context: functions.https.CallableContext) => {
        // Check if sender is authenticated.
        if (!context.auth || (!context.auth.token.participant && !context.auth.token.coordinator))
            logMsg(GENERIC_ERRORS.GENERR_NO_AUTH_USER_FOUND, MsgType.ERROR)

        if (!data.ceremonyId || !data.uploadId) logMsg(GENERIC_ERRORS.GENERR_MISSING_INPUT, MsgType.ERROR)

        // Get DB.
        const firestore = admin.firestore()

        // Get data.
        const { ceremonyId } = data
        const userId = context.auth?.uid

        // Look for documents.
        const ceremonyDoc = await firestore.collection(commonTerms.collections.ceremonies.name).doc(ceremonyId).get()
        const participantDoc = await firestore.collection(getParticipantsCollectionPath(ceremonyId)).doc(userId!).get()

        // Check existence.
        if (!ceremonyDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)
        if (!participantDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT, MsgType.ERROR)

        // Get data.
        const participantData = participantDoc.data()

        if (!participantData) logMsg(GENERIC_ERRORS.GENERR_NO_DATA, MsgType.ERROR)

        logMsg(`Ceremony document ${ceremonyId} okay`, MsgType.DEBUG)
        logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

        // Check if has reached the uploading step while contributing.
        if (participantData?.contributionStep !== ParticipantContributionStep.UPLOADING)
            logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT_CONTRIBUTION_STEP, MsgType.ERROR)

        // Update.
        await participantDoc.ref.set(
            {
                ...participantData!,
                tempContributionData: {
                    ...participantData?.tempContributionData,
                    uploadId: data.uploadId,
                    chunks: []
                },
                lastUpdated: getCurrentServerTimestampInMillis()
            },
            { merge: true }
        )
    }
)

/**
 * Temporary store the ETag and PartNumber for each uploaded chunk in order to make the upload resumable from last chunk.
 */
export const temporaryStoreCurrentContributionUploadedChunkData = functions.https.onCall(
    async (data: any, context: functions.https.CallableContext) => {
        // Check if sender is authenticated.
        if (!context.auth || (!context.auth.token.participant && !context.auth.token.coordinator))
            logMsg(GENERIC_ERRORS.GENERR_NO_AUTH_USER_FOUND, MsgType.ERROR)

        if (!data.ceremonyId || !data.eTag || data.partNumber <= 0)
            logMsg(GENERIC_ERRORS.GENERR_MISSING_INPUT, MsgType.ERROR)

        // Get DB.
        const firestore = admin.firestore()

        // Get data.
        const { ceremonyId } = data
        const userId = context.auth?.uid

        // Look for documents.
        const ceremonyDoc = await firestore.collection(commonTerms.collections.ceremonies.name).doc(ceremonyId).get()
        const participantDoc = await firestore.collection(getParticipantsCollectionPath(ceremonyId)).doc(userId!).get()

        // Check existence.
        if (!ceremonyDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_CEREMONY, MsgType.ERROR)
        if (!participantDoc.exists) logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT, MsgType.ERROR)

        // Get data.
        const participantData = participantDoc.data()

        if (!participantData) logMsg(GENERIC_ERRORS.GENERR_NO_DATA, MsgType.ERROR)

        logMsg(`Ceremony document ${ceremonyId} okay`, MsgType.DEBUG)
        logMsg(`Participant document ${participantDoc.id} okay`, MsgType.DEBUG)

        // Check if has reached the uploading step while contributing.
        if (participantData?.contributionStep !== ParticipantContributionStep.UPLOADING)
            logMsg(GENERIC_ERRORS.GENERR_INVALID_PARTICIPANT_CONTRIBUTION_STEP, MsgType.ERROR)

        const chunks = participantData?.tempContributionData.chunks ? participantData?.tempContributionData.chunks : []

        // Add last chunk.
        chunks.push({
            ETag: data.eTag,
            PartNumber: data.partNumber
        })

        // Update.
        await participantDoc.ref.set(
            {
                ...participantData!,
                tempContributionData: {
                    ...participantData?.tempContributionData,
                    chunks
                },
                lastUpdated: getCurrentServerTimestampInMillis()
            },
            { merge: true }
        )
    }
)
